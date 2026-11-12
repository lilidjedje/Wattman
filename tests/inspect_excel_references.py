"""Read-only inventory of saved Excel errors and broken formula references.

No Excel engine is invoked: these are saved error values, not fresh recalculation.
Usage: python tests/inspect_excel_references.py [--strict]
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import posixpath
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def inspect(path):
    issues, sheets = [], []
    with ZipFile(path) as archive:
        relationships = {item.get('Id'): item.get('Target')
                         for item in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        for sheet in workbook.find(NS + 'sheets'):
            target = relationships[sheet.get(REL + 'id')]
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            counts = Counter()
            for cell in ET.fromstring(archive.read(target)).iter(NS + 'c'):
                value, formula = cell.find(NS + 'v'), cell.find(NS + 'f')
                raw = value.text if value is not None else None
                expression = formula.text if formula is not None else None
                error = raw if cell.get('t') == 'e' else None
                broken = bool(expression and '#REF!' in expression)
                if error or broken:
                    counts[error or 'broken_formula_without_cached_error'] += 1
                    issues.append({'sheet': sheet.get('name'), 'cell': cell.get('r'),
                                   'error': error, 'broken_formula': broken, 'formula': expression})
            if counts:
                sheets.append({'sheet': sheet.get('name'), 'errors': dict(counts)})
    return {'file': str(path.relative_to(ROOT)), 'sheets_with_errors': sheets,
            'error_counts': dict(Counter(issue['error'] or 'broken_formula_without_cached_error' for issue in issues)),
            'issues': issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--strict', action='store_true', help='Fail if any source contains errors')
    args = parser.parse_args()
    reports = [inspect(path) for path in sorted([*ROOT.glob('*.xlsx'), *(ROOT / 'excel_templates').glob('*.xlsx')])]
    destination = ROOT / 'outputs/calculation-audit/excel-source-inventory.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
    for report in reports:
        print(report['file'], report['error_counts'])
    print(f'Detailed locations: {destination}')
    return 1 if args.strict and any(r['issues'] for r in reports) else 0


if __name__ == '__main__':
    raise SystemExit(main())
