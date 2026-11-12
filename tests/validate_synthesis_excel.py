"""Validate the real Excel endpoint using payloads calculated in Chromium."""
import json
import math
import os
import sys
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
with tempfile.TemporaryDirectory() as folder:
    os.environ['ENGINEERING_APP_DATA']=folder
    from app import app, export_synthesis_excel_bundle
    from synthesis_excel import CUSTOMER_SHEETS, SCENARIOS, CUSTOMER_VALUE_ROWS
    case=int(sys.argv[1])
    payload=json.loads((ROOT/f'tmp/excel-tests/case-{case}.json').read_text(encoding='utf-8'))
    with app.test_request_context('/export_synthesis_excel_bundle',method='POST',json=payload):
        response=export_synthesis_excel_bundle()
        assert not isinstance(response,tuple), response[0].get_json() if isinstance(response,tuple) else ''
        assert response.status_code==200
        response.direct_passthrough=False
        with zipfile.ZipFile(BytesIO(response.get_data())) as archive:
            output=archive.read('Consoveille_Synthese.xlsx')
    workbook=load_workbook(BytesIO(output),data_only=False)
    source=load_workbook(ROOT/'Consoveille.xlsx',data_only=False,read_only=True)
    related={'Mounting Mode','Logistic Mode','Logistic Wo unplug','Delivery','Customer Mode',*CUSTOMER_SHEETS.values()}
    related.update(name for name in source.sheetnames if name.lower().startswith('biberonnage_23'))
    for original in source:
        if original.title not in related:
            actual=workbook[original.title]
            assert actual.sheet_state=='visible',original.title
            for row in original:
                for cell in row:
                    if cell.value is None:
                        continue
                    actual_value=actual[cell.coordinate].value
                    expected_value=cell.value
                    if isinstance(actual_value,(int,float)) and isinstance(expected_value,(int,float)):
                        assert math.isclose(actual_value,expected_value,rel_tol=1e-12,abs_tol=1e-12),(original.title,cell.coordinate)
                        continue
                    assert getattr(actual_value,'__dict__',actual_value)==getattr(expected_value,'__dict__',expected_value),(original.title,cell.coordinate)
    visible=[sheet for sheet in workbook if sheet.sheet_state=='visible']
    deliveries=[s for s in visible if s.title.startswith('Delivery ')]
    expected_delivery=[]
    for report in payload['reports']:
        module=report['module']; profiles=report['data']['profiles']
        if module in ('dm1','dm2'):
            for profile in profiles:
                expected_delivery.append((module.upper(),profile))
        if module=='customer':
            matrix=workbook['Customer Mode projet']
            assert matrix.sheet_state=='visible'
            for row_index,device in enumerate(report['data']['matrixRows'],4):
                expected=float(device['currentUa'])+float(device['technicalWakeupA'])*1000000+float(device['smartmosUa'])
                assert math.isclose(matrix.cell(row_index,5).value,expected,abs_tol=1e-9)
            for profile in profiles:
                sheet=workbook[CUSTOMER_SHEETS[profile['id']]]
                assert sheet.sheet_state=='visible'
                selected={c['key']:c for c in profile['columns']}
                for col,key in enumerate(SCENARIOS,5):
                    assert sheet.column_dimensions[chr(64+col)].hidden==(key not in selected)
                    if key in selected:
                        assert str(sheet.cell(4,col).value)==str(selected[key]['label'])
                        assert abs(sheet.cell(6,col).value-selected[key]['autonomy'])<1e-8
                        for row in CUSTOMER_VALUE_ROWS:
                            expected=selected[key]['rows'][str(row)]
                            actual=sheet.cell(row,col).value
                            assert isinstance(actual,(int,float)),(sheet.title,row,col,actual)
                            assert math.isclose(actual,expected,rel_tol=1e-12,abs_tol=1e-12),(sheet.title,row,col,actual,expected)
                        assert sheet.cell(58,col).value>0, 'Edited FOTA duration must replace a blank template cell'
            for key,title in CUSTOMER_SHEETS.items():
                assert (workbook[title].sheet_state=='visible')==(key in report['selection']['profiles'])
    logistics=[s for s in visible if s.title.startswith('Logistic ')]
    assert len(logistics)==sum(len(p['columns']) for _,p in expected_delivery)
    for sheet in logistics:
        assert sheet.cell(4,1).value=='ECU selectionne'
        assert sheet.cell(4,6).value in (750,575)
        assert math.isclose(sheet.cell(4,5).value,sheet.cell(4,2).value+sheet.cell(4,3).value*1000000+sheet.cell(4,4).value,abs_tol=1e-9)
    mountains=[sheet for sheet in visible if sheet.title.startswith('Mountain Mode ')]
    assert len(mountains)==len(expected_delivery)
    for sheet in mountains:
        assert sheet.cell(4,1).value=='ECU selectionne'
        assert sheet.cell(4,6).value in (750,575)
    assert len(deliveries)==len(expected_delivery)
    for sheet,(mode,profile) in zip(deliveries,expected_delivery):
        assert mode in sheet.title
        assert profile['name'] in sheet['A6'].value
        for column in profile['columns']:
            index=5 if column['scenario']['key']=='baseLab' else 7
            assert sheet.cell(8,index).value==profile['capacity']
            assert abs(sheet.cell(6,index).value-column['autonomy'])<1e-8
            assert abs(sheet.cell(92,index).value-column['dailyTotal'])<1e-8
            expected_rows={
                10:column['startSoc']/100,11:column['minSoc']/100,
                13:column['gross'],15:column['vehicleCount'],16:column['vehicleUnit'],17:column['vehicleTotal'],
                44:column['available'],46:column['instantaneous']/1000,47:column['sleepCurrentEnergy'],
                49:column['wakePeriod'],50:column['wakeDuration'],51:column['wakeCurrent'],
                52:column['balancingDuration'],53:column['balancingCurrent'],54:column['technicalWake'],
                64:column['sleep']['alarm'],65:column['alarmEnergy'],67:column['sleep']['sansEbdu'],68:column['sansEbduEnergy'],
                71:column['sleep']['twt']['single'].get('ivcCurrent',0),
                72:column['sleep']['twt']['single'].get('powerlatchCurrent',0),
                73:column['sleep']['twt']['single'].get('durationSeconds',0),
                74:column['twtSingleEnergy'],84:column['twtSingleEnergy'],89:column['sleep']['agingSoc']/100,
                90:column['agingEnergy'],97:column['fixedTotal'],98:column['customSleepEnergy'],
            }
            for name,rows in {'pcuRam':(26,27,28),'cdcRam':(30,31,32),'ivc3':(34,35,36)}.items():
                included=name=='pcuRam' or column['scenario']['key']=='withoutAlarmTachy'
                entry=column['fixed']['entries'][name]
                for row,value in zip(rows,(entry['current'],entry['duration'],column['fixedEnergies'][name])):
                    expected_rows[row]=value if included else 0
            entry=column['fixed']['entries']['cellBalancing']
            expected_rows.update({19:entry['extra']['periodMin'],20:entry['current'],21:entry['duration'],
                                  23:entry['extra']['balancingDays'],24:column['fixedEnergies']['cellBalancing'],
                                  22:column['fixedEnergies']['cellBalancing']/entry['extra']['balancingDays']})
            entry=column['fixed']['entries']['transport']
            expected_rows.update({39:entry['current'],40:entry['current']/1000*24,41:entry['duration'],42:column['fixedEnergies']['transport']})
            for row,expected in expected_rows.items():
                actual=sheet.cell(row,index).value
                assert isinstance(actual,(int,float)),(sheet.title,row,index,actual)
                assert math.isclose(actual,expected,rel_tol=1e-12,abs_tol=1e-12),(sheet.title,row,index,actual,expected)
            # Reconcile totals independently from the individual exported rows.
            value=lambda row:sheet.cell(row,index).value
            assert math.isclose(value(13),value(8)*(value(10)-value(11)),abs_tol=1e-10)
            assert math.isclose(value(44),value(13)-value(17)-value(97),abs_tol=1e-10)
            assert math.isclose(value(92),sum(value(row) for row in (47,54,65,68,84,90,98)),abs_tol=1e-10)
            assert math.isclose(value(6),max(0,value(44))/value(92),abs_tol=1e-10)
        custom_rows=[row for row in sheet if 'Fonction ajoutee' in str(row[1].value)]
        assert len(custom_rows)==len(profile['columns'])
        for row,column in zip(custom_rows,profile['columns']):
            index=5 if column['scenario']['key']=='baseLab' else 7
            assert math.isclose(sheet.cell(row[0].row,index).value,0.0625,abs_tol=1e-12)
        selected={5 if c['scenario']['key']=='baseLab' else 7 for c in profile['columns']}
        for index in (5,6,7,8,9):assert sheet.column_dimensions[chr(64+index)].hidden==(index not in selected)
    bibs=[r for r in payload['reports'] if r['module']=='biberonnage']
    if bibs:
        bib_sheets=[sheet for sheet in visible if sheet.title.startswith('Biberonnage 23')]
        assert len(bib_sheets)==len({p['id'] for r in bibs for p in r['data']['profiles']})
        for sheet in bib_sheets:
            aux_x=4+max(len(p['timeline']) for r in bibs for p in r['data']['profiles'] if sheet['A1'].value.endswith(' - '+p['name']))
            titles=[str(cell.value) for row in sheet for cell in row if str(cell.value).startswith('Biberonnage ')]
            expected=[f'Biberonnage {r["data"]["days"]} jours - {p["name"]}' for r in bibs for p in r['data']['profiles'] if p['name']==sheet['A1'].value.split(' - ',1)[1]]
            assert sorted(titles)==sorted(expected),(titles,expected)
            assert len(sheet._charts)==len(expected)
            for row in sheet:
                if str(row[0].value).startswith('Biberonnage '):
                    section=row[0].row
                    report=next(r for r in bibs if f'{r["data"]["days"]} jours' in row[0].value)
                    profile=next(p for p in report['data']['profiles'] if row[0].value.endswith(' - '+p['name']))
                    result=profile['result']
                    for offset,key in enumerate(('capacityAh','startSoc','sumVeilleAh','totalLossL1','totalLossL2','totalRechargeAh','totalCost','bibCount'),2):
                        assert math.isclose(sheet.cell(section+offset,2).value,result[key],abs_tol=1e-9),(row[0].value,key)
                    header=section+11
                    for offset,point in enumerate(profile['timeline'],1):
                        expected_values=[point['days'],result['socCurrent'][offset-1],result['intervalAh'][offset-1],result['losses'][offset-1],result['recharges'][offset-1]]
                        for col,expected_value in enumerate(expected_values,1):
                            actual=sheet.cell(header+offset,col).value
                            assert actual is None if expected_value is None else math.isclose(actual,expected_value,abs_tol=1e-9)
                    if profile.get('inputRows'):
                        first=next(cell.row for line in sheet for cell in line if cell.value=='Donnees de consommation selectionnees' and cell.row>section)
                        source_input=profile['inputRows'][0]
                        assert sheet.cell(first+2,1).value==source_input['name']
                        for col,point in enumerate(profile['timeline'],3):
                            assert math.isclose(sheet.cell(first+2,col).value,source_input['values'][point['label']],abs_tol=1e-12)
                    for offset,point in enumerate(result['socPoints'],1):
                        assert math.isclose(sheet.cell(header+offset,aux_x).value,point['x'],abs_tol=1e-9)
                        assert math.isclose(sheet.cell(header+offset,aux_x+1).value,point['y'],abs_tol=1e-9)
    if 'customer' not in payload['modules']:
        assert all(workbook[name].sheet_state!='visible' for name in ['Customer Mode',*CUSTOMER_SHEETS.values()])
    if payload.get('applicationData'):
        assert 'Parametres application' in workbook
        inputs=workbook['Wattman Device List']
        name_column=next(cell.column for cell in inputs[1] if cell.value=='Device Name')
        assert inputs.cell(2,name_column).value=='ECU selectionne'
        params={row[0].value:row[1].value for row in workbook['Parametres application'] if len(row)>1}
        assert params['fixedConsumptionDM1.baseLab.entries.pcuRam.current']=='1,5'
    (ROOT/f'tmp/excel-tests/case-{case}.xlsx').write_bytes(output)
    print(f'Excel case {case}: selected profiles/scenarios/durations, numeric results and all unrelated reference pages verified.')
    workbook.close();source.close()
