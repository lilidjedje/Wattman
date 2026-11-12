"""Populate the separate DCDC/WLTC reference workbooks from application inputs."""
from copy import copy
from io import BytesIO
from pathlib import Path
import math
import re

from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
from openpyxl.chart import ScatterChart, Series, Reference
from openpyxl.formula.tokenizer import Tokenizer
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter as letter

WINDOWS = {
    'dcdc': {key: [(0,5),(5,10),(10,15),(15,25),(25,30)] for key in ('winter','midseason','summer')},
    'wltc': {'cycle1':[(0,1.67),(1.67,4),(4,7),(7,8.16),(8.16,12.25),(12.25,25),(25,30)],
             'cycle2':[(0,5),(5,7),(7,8.16),(8.16,15),(15,25),(25,30)],
             'cycle3':[(0,5),(5,7),(7,8.16),(8.16,15),(15,25),(25,30)]}}


def number(value, fallback=0):
    if value is None or str(value).strip() == '':
        return fallback
    try:
        result=float(re.sub(r'\s+', '', str(value)).replace(',', '.').replace('%',''))
    except (TypeError,ValueError):
        raise ValueError(f'Valeur numérique invalide : {value}')
    if not math.isfinite(result):
        raise ValueError('Un courant ou un coefficient est non fini.')
    return result


def insert_equipment_rows(workbook, sheet, boundary, count):
    """Extend native input space while updating affected formulas and merges."""
    if count <= 0:
        return
    merges=list(sheet.merged_cells.ranges)
    for merged in merges:
        sheet.unmerge_cells(str(merged))
    sheet.insert_rows(boundary,count)
    for merged in merges:
        start=merged.min_row+(count if merged.min_row>=boundary else 0)
        end=merged.max_row+(count if merged.max_row>=boundary else 0)
        sheet.merge_cells(start_row=start,end_row=end,start_column=merged.min_col,end_column=merged.max_col)
    pattern=re.compile(r'(\$?[A-Z]{1,3}\$?)(\d+)')
    def shifted(reference, local=False):
        if '!' in reference:
            prefix,coords=reference.rsplit('!',1)
            if prefix.strip("'")!=sheet.title:return reference
            return prefix+'!'+pattern.sub(lambda m:m[1]+str(int(m[2])+(count if int(m[2])>=boundary else 0)),coords)
        if not local:return reference
        return pattern.sub(lambda m:m[1]+str(int(m[2])+(count if int(m[2])>=boundary else 0)),reference)
    for worksheet in workbook:
        for row in worksheet:
            for cell in row:
                if cell.data_type!='f' or not isinstance(cell.value,str):continue
                try:
                    tokens=Tokenizer(cell.value)
                    for token in tokens.items:
                        if token.type=='OPERAND' and token.subtype=='RANGE':token.value=shifted(token.value,worksheet==sheet)
                    cell.value=tokens.render()
                except Exception as exc:
                    raise ValueError(f'Impossible de déplacer la formule {worksheet.title}!{cell.coordinate}') from exc
    for row in range(boundary,boundary+count):
        for col in range(1,sheet.max_column+1):
            sheet.cell(row,col)._style=copy(sheet.cell(boundary-1,col)._style)


def build_sizing_excel(payload, root):
    module=payload.get('module') or 'dcdc'
    if module not in WINDOWS:raise ValueError('Mode Excel inconnu.')
    path=Path(root)/'excel_templates'/('DCDC Test.xlsx' if module=='dcdc' else 'WLTC test.xlsx')
    if not path.is_file():raise ValueError(f'Modèle Excel introuvable : {path.name}')
    workbook=load_workbook(path,keep_links=True)
    sheet,graph=workbook.worksheets[:2]
    devices=[dict(item) for item in payload.get('devices') or [] if str(item.get('name') or '').strip()]
    if module=='dcdc' and not any(str(item['name']).strip().upper() in ('ADAPTATION','ADAPTATIONS') for item in devices):
        devices.append({'name':'ADAPTATIONS','current':0,'lower':1,'upper':0})
    start,end,header,cur_col=(9,128,8,10) if module=='dcdc' else (15,74,14,10)
    extra=max(0,len(devices)-(end-start+1))
    insert_equipment_rows(workbook,sheet,end,extra)
    end+=extra
    shift=lambda row:row+extra
    profiles=list(WINDOWS[module])
    starts=[11,17,24] if module=='dcdc' else [11,18,24]
    max_cols=[16,23,34] if module=='dcdc' else [31,32,33]
    last_col=34 if module=='dcdc' else 33
    # Existing time bands are replaced by the application's authoritative bands.
    for merged in list(sheet.merged_cells.ranges):
        if merged.min_col>=11 and merged.min_row>=header-1:
            sheet.unmerge_cells(str(merged))
    for row in sheet.iter_rows(min_row=start,max_row=end,max_col=sheet.max_column):
        for cell in row:
            if not isinstance(cell,MergedCell):cell.value=None
    sheet.cell(2 if module=='dcdc' else 3,3,str((payload.get('project') or {}).get('name') or ''))
    sheet.cell(4 if module=='dcdc' else 5,3,str((payload.get('project') or {}).get('pilotWattman') or ''))
    if module=='wltc':sheet.cell(4,3,str((payload.get('project') or {}).get('date') or ''))
    source=payload.get('synthesis') or {}
    data=source.get(module) or {}
    output=next((number(row['dcdcOutput']) for rows in data.values() for row in rows if row.get('dcdcOutput') is not None),250)
    output_cell=f'C{shift(134 if module=="dcdc" else 80)}'
    sheet[output_cell]=output
    if module=='dcdc':
        sheet.cell(shift(135),3,f'={output_cell}')
        sheet.cell(shift(132),4,f'={output_cell}*C{shift(130)}')
    else:sheet.cell(shift(80),4,f'={output_cell}')
    sheet.cell(header,6,'Base');sheet.cell(header,7,'Upper')
    for i,device in enumerate(devices,start):
        sheet.row_dimensions[i].hidden=False
        sheet.cell(i,2,str(device['name']))
        sheet.cell(i,6,number(device.get('lower'),1));sheet.cell(i,7,number(device.get('upper')))
        sheet.cell(i,8,0);sheet.cell(i,9,0)
        sheet.cell(i,cur_col,number(device.get('current'))).number_format='0.000000'
        sheet.cell(i,2).alignment=Alignment(wrap_text=True,vertical='center')
    for row in range(start+len(devices),end+1):sheet.row_dimensions[row].hidden=True
    upper_row,base_row=(shift(136),shift(137)) if module=='dcdc' else (shift(82),shift(83))
    graph._charts=[]
    graph_starts=[1,7,12] if module=='dcdc' else [1,6,11]
    graph_header,graph_first=(6,7) if module=='dcdc' else (10,11)
    for profile_index,profile in enumerate(profiles):
        windows=WINDOWS[module][profile]
        columns=list(range(starts[profile_index],starts[profile_index]+len(windows)))
        profile_name=profile.capitalize() if module=='dcdc' else f'Cycle {profile_index+1}'
        if profile=='midseason':profile_name='Mid-season'
        # Clear superseded template time bands and weighted formulas.
        reserved_end=(16 if profile_index==0 else 23 if profile_index==1 else 34) if module=='dcdc' else (17 if profile_index==0 else 23 if profile_index==1 else 33)
        for col in range(starts[profile_index],reserved_end+1):
            sheet.cell(header,col).value=None
            sheet.column_dimensions[letter(col)].hidden=col not in columns and col!=max_cols[profile_index]
        sheet.cell(header-1,columns[0],profile_name)
        for col,(begin,finish) in zip(columns,windows):
            sheet.cell(header,col,f'{begin:g} - {finish:g} min')
            for i,device in enumerate(devices,start):
                values=(device.get('dcdcProfiles' if module=='dcdc' else 'wltcProfiles') or {}).get(profile) or []
                coefficient=number(values[col-columns[0]],100) if col-columns[0]<len(values) else 100
                if not 0<=coefficient<=100:raise ValueError('Un coefficient de profil doit être compris entre 0 et 100 %.')
                sheet.cell(i,col,coefficient/100).number_format='0.##%'
            for total_row,bound in [(upper_row,'G'),(base_row,'F')]:
                sheet.cell(total_row,col,f'=SUMPRODUCT(${bound}${start}:${bound}${end},$J${start}:$J${end},{letter(col)}{start}:{letter(col)}{end})')
            # Repair every directly affected native consumption / energy calculation.
            duration=finish-begin
            if module=='dcdc':
                for diff,energy,total in [(141,142,upper_row),(143,144,base_row)]:
                    sheet.cell(shift(diff),col,f'={output_cell}-{letter(col)}{total}')
                    sheet.cell(shift(energy),col,f'={letter(col)}{shift(diff)}*{duration:g}/60')
                for active,energy,diff in [(146,147,141),(148,149,143)]:
                    sheet.cell(shift(active),col,f'=MIN($E${shift(145 if profile_index==2 else 146 if profile_index==1 else 147)},{letter(col)}{shift(diff)})')
                    sheet.cell(shift(energy),col,f'={letter(col)}{shift(active)}*{duration:g}/60')
            else:
                for diff,energy,total in [(87,88,upper_row),(89,90,base_row)]:
                    sheet.cell(shift(diff),col,f'={output_cell}-{letter(col)}{total}')
                    sheet.cell(shift(energy),col,f'={letter(col)}{shift(diff)}*{duration:g}/60')
                for active,energy,diff in [(92,93,87),(94,95,89)]:
                    sheet.cell(shift(active),col,f'=MIN($E${shift(93)},{letter(col)}{shift(diff)})')
                    sheet.cell(shift(energy),col,f'={letter(col)}{shift(active)}*{duration:g}/60')
                for power,total,weighted in [(101,upper_row,106),(102,base_row,109),(103,upper_row,112),(104,base_row,115)]:
                    sheet.cell(shift(power),col,f'=$C${shift(76)}*{letter(col)}{total}')
                    sheet.cell(shift(weighted),col,f'={letter(col)}{shift(power)}*{duration:g}/30')
                for summary,weighted in [(107,106),(110,109),(113,112),(116,115)]:
                    sheet.cell(shift(summary),columns[0],f'=SUM({letter(columns[0])}{shift(weighted)}:{letter(columns[-1])}{shift(weighted)})')
        max_col=max_cols[profile_index]
        sheet.cell(header-1,max_col,'MAX')
        for row in [*range(start,start+len(devices)),upper_row,base_row]:
            sheet.cell(row,max_col,f'=MAX({letter(columns[0])}{row}:{letter(columns[-1])}{row})')
        # Native input cells determine chart series, rather than cached screenshots.
        graph_col=graph_starts[profile_index]
        for col,label in zip(range(graph_col,graph_col+4),['Temps (min)','Base (A)','Upper (A)','Sortie DCDC (A)']):graph.cell(graph_header,col,label)
        graph.cell(graph_header-1,graph_col,profile_name)
        for offset in range(24):
            for col in range(graph_col,graph_col+4):graph.cell(graph_first+offset,col).value=None
        records=[]
        for index,((begin,finish),col) in enumerate(zip(windows,columns)):
            expected={bound:sum(number(device.get(bound),1 if bound=='lower' else 0)*number(device.get('current'))*
                number(((device.get('dcdcProfiles' if module=='dcdc' else 'wltcProfiles') or {}).get(profile) or [100]*len(windows))[index] if index<len((device.get('dcdcProfiles' if module=='dcdc' else 'wltcProfiles') or {}).get(profile) or [100]*len(windows)) else 100)/100 for device in devices) for bound in ('lower','upper')}
            supplied=data.get(profile) or []
            if supplied:
                if len(supplied)!=len(windows)*2:raise ValueError(f'Plages de temps incohérentes pour {profile_name}.')
                for offset,time in [(0,begin),(1,finish)]:
                    record=supplied[index*2+offset]
                    if not all(math.isclose(number(record[field]),value,rel_tol=1e-9,abs_tol=1e-8) for field,value in [('time',time),('base',expected['lower']),('upper',expected['upper'])]):
                        raise ValueError(f'Le bilan {profile_name} ne correspond pas aux ECU et paramètres envoyés. Actualisez la synthèse.')
            for time in (begin,finish):
                row=graph_first+len(records);records.append(time)
                graph.cell(row,graph_col,time)
                graph.cell(row,graph_col+1,f"='{sheet.title}'!{letter(col)}{base_row}")
                graph.cell(row,graph_col+2,f"='{sheet.title}'!{letter(col)}{upper_row}")
                graph.cell(row,graph_col+3,f"='{sheet.title}'!{output_cell}")
        chart=ScatterChart();chart.title=profile_name;chart.x_axis.title='Temps (min)';chart.y_axis.title='Courant (A)';chart.scatterStyle='line';chart.width=25;chart.height=12
        for index,color in [(1,'2463B0'),(2,'15806C'),(3,'BA4D48')]:
            series=Series(Reference(graph,min_col=graph_col+index,min_row=graph_first,max_row=graph_first+len(records)-1),Reference(graph,min_col=graph_col,min_row=graph_first,max_row=graph_first+len(records)-1),title=['','Base','Upper','Sortie DCDC'][index])
            series.graphicalProperties.line.solidFill=color;chart.series.append(series)
        graph.add_chart(chart,f'A{28+profile_index*25}')
    # The template's variant columns are superseded by the actual Base/Upper selection.
    for row in (shift(138),shift(139)) if module=='dcdc' else (shift(84),shift(85)):
        for col in range(11,last_col+1):sheet.cell(row,col,0)
    workbook.calculation.fullCalcOnLoad=True;workbook.calculation.forceFullCalc=True;workbook.calculation.calcMode='auto'
    workbook.active=0
    result=BytesIO();workbook.save(result);workbook.close();return result.getvalue()
