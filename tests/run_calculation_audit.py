"""Run tests in isolated processes (the two Flask backends are both named app).

Usage: python tests/run_calculation_audit.py [--iterations 250] [--seed 20261112]
       [--all] [--report outputs/calculation-audit/results.json]
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CALCULATION_TESTS = [
    'test_current_units.cjs', 'test_wattman_current.cjs', 'test_sleep_current.cjs',
    'test_autonomy_current_contributions.cjs', 'test_dm_energy.cjs',
    'test_autonomy_profiles.cjs',
    'test_customer_autonomy.cjs', 'test_biberonnage.cjs', 'test_synthesis.cjs',
    'test_synthesis_biberonnage_durations.cjs', 'test_calculation_properties.cjs',
    'test_homologation_properties.cjs',
    'test_excel_calculation_oracle.py', 'test_autonomy_integration.py',
    'test_sizing_calculations.py',
    'test_synthesis_excel_numbers.py', 'test_homologation_reference.py',
    'test_dcdc_adaptations_export.py', 'test_biberonnage_routes.py',
    'test_measurement_dashboard.py', 'test_digital_capture.py',
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=250)
    parser.add_argument('--seed', type=int, default=20261112)
    parser.add_argument('--all', action='store_true', help='Also run non-calculation unit tests')
    parser.add_argument('--report', default='outputs/calculation-audit/results.json')
    args = parser.parse_args()
    if args.iterations <= 0:
        parser.error('--iterations must be positive')
    tests = sorted(p.name for p in (ROOT / 'tests').glob('test_*')
                   if p.suffix in ('.py', '.cjs')) if args.all else CALCULATION_TESTS
    env = {**os.environ, 'PYTHONPATH': str(ROOT), 'PYTHONIOENCODING': 'utf-8',
           'CALC_ITERATIONS': str(args.iterations), 'CALC_SEED': str(args.seed)}
    results = []
    report = ROOT / args.report
    report.parent.mkdir(parents=True, exist_ok=True)
    for name in tests:
        print(f'RUN {name}', flush=True)
        command = (['node', str(ROOT / 'tests' / name)] if name.endswith('.cjs') else
                   [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', name, '-v'])
        started = time.monotonic()
        try:
            run = subprocess.run(command, cwd=ROOT, env=env, capture_output=True,
                                 text=True, encoding='utf-8', errors='replace', timeout=600)
            output, code = run.stdout + run.stderr, run.returncode
        except subprocess.TimeoutExpired as exc:
            output, code = f'Timeout after {exc.timeout}s', 124
        log = report.parent / f'{Path(name).stem}.log'
        log.write_text(output, encoding='utf-8')
        results.append({'test': name, 'passed': code == 0, 'exit_code': code,
                        'seconds': round(time.monotonic() - started, 3), 'log': str(log)})
        print(f'{"PASS" if code == 0 else "FAIL"} {name} ({results[-1]["seconds"]}s)', flush=True)
        if code:
            print(output[-6000:], flush=True)
        report.write_text(json.dumps({'seed': args.seed, 'iterations': args.iterations,
                                     'results': results}, indent=2), encoding='utf-8')
    failed = sum(not item['passed'] for item in results)
    print(f'{len(results) - failed}/{len(results)} suites passed; report: {report}', flush=True)
    return bool(failed)


if __name__ == '__main__':
    sys.exit(main())
