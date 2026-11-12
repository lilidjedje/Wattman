"""Validate real native PDFs, including their selectable text and vector content."""
import json
import os
import re
from pathlib import Path
import sys
import tempfile
from io import BytesIO
from pypdf import PdfReader
import pymupdf

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
source=Path(sys.argv[1])
payload=json.loads(source.read_text(encoding='utf-8'))
with tempfile.TemporaryDirectory() as folder:
    os.environ['ENGINEERING_APP_DATA']=folder
    from app import app,generate_synthesis_pdf
    with app.test_request_context('/generate_synthesis_pdf',method='POST',json=payload):
        response=generate_synthesis_pdf()
        assert not isinstance(response,tuple),response[0].get_json() if isinstance(response,tuple) else ''
        assert response.status_code==200
        assert response.mimetype=='application/pdf'
        response.direct_passthrough=False
        output=response.get_data()
path=source.with_suffix('.pdf');path.write_bytes(output)
reader=PdfReader(BytesIO(output));document=pymupdf.open(stream=output,filetype='pdf')
text='\n'.join(page.extract_text() for page in reader.pages)
normalized_text=re.sub(r'\s+',' ',text)
assert 'Sommaire' in text
assert reader.outline
assert any(annotation.get_object().get('/Subtype')=='/Link' for annotation in reader.pages[1].get('/Annots',[]))
for index,page in enumerate(reader.pages):
    assert abs(float(page.mediabox.width)-595.2756)<.01
    assert abs(float(page.mediabox.height)-841.8898)<.01
    assert len(page.extract_text().strip())>90,(index+1,'nearly empty page')
    assert not list(page.images),(index+1,'raster screenshot in native report')
    assert f'Page {index+1:02d}' in page.extract_text()
    for word in document[index].get_text('words'):
        assert word[0]>=44 and word[2]<=552,(index+1,word)
        assert word[1]>=18 and word[3]<=823,(index+1,word)
if 'dcdc' in payload['modules']:
    count=sum(report['module']=='dcdc' for report in payload['reports'])
    assert text.count('Winter')==count
    assert text.count('Mid-season')==count
    assert text.count('Summer')==count
if 'wltc' in payload['modules']:
    for i in range(1,4):assert text.count(f'Cycle {i}')==sum(report['module']=='wltc' for report in payload['reports'])
for report in payload['reports']:
    if report['module'] in ('dm1','dm2'):
        for profile in report['data']['profiles']:assert re.sub(r'\s+',' ',profile['name'].replace('–','-')) in normalized_text
assert sum(len(page.get_drawings()) for page in document)>10
chapter_sizes=[round(span['size'],1) for page in document for block in page.get_text('dict')['blocks'] if 'lines' in block for line in block['lines'] for span in line['spans'] if any(span['text'].startswith(name) for name in ('Dimensionnement DCDC','Cycles WLTC','Autonomie DM1','Autonomie DM2','Autonomie Customer Mode','Biberonnage')) and span['size']>15]
assert chapter_sizes and set(chapter_sizes)=={21.0},chapter_sizes
print(f'Native PDF: {len(reader.pages)} A4 pages; no blank pages, no screenshots, vector charts, selectable text, linked contents and consistent headings verified.')
