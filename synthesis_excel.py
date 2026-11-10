"""Populate the Consoveille template from the selected, calculated browser reports."""
import math
import re
from openpyxl.chart import ScatterChart, Series, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

CUSTOMER_SHEETS = {'Customer': 'Customer', 'CustomerWO': 'Customer wo unplung', 'CustomerPIE': 'Customer PIE'}
SCENARIOS = ['baseLab', 'withAlarm', 'withoutAlarmTachy', 'alarmTachy', 'baseLib']
# The application's calculated parameter rows, including editable inputs that
# happen to be blank in the original workbook (for example FOTA duration).
CUSTOMER_VALUE_ROWS = (
    8, 10, 11, 13, 15, 16, 17, 19, 20, 21, 22, 23, 24, 26, 27, 28,
    30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49,
    50, 51, 52, 53, 54, 55, 57, 58, 59, 61, 62, 63, 64, 66, 67, 68,
    69, 71, 72, 73, 74, 76, 77, 78, 79, 81, 82, 83, 84, 86, 88, 89,
    91, 92, 93, 94, 95, 96, 99, 100, 101, 102, 103, 104, 106, 107,
    109, 110, 112, 113, 115, 116, 118, 119, 121,
)


def text(cell, value):
    cell.value = str(value or '')[:32767]
    cell.data_type = 's'


def number(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = re.sub(r'\s+', '', value).replace(',', '.')
        if not value:
            return 0.0  # Empty editable inputs are zero in the browser model.
    try:
        result = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError('Un résultat Excel est non numérique.') from exc
    if not math.isfinite(result):
        raise ValueError('Un résultat Excel est non numérique ou infini.')
    return result


def unique_title(workbook, title):
    base = re.sub(r'[\\/*?:\[\]]', '-', title).strip(" '") or 'Profil'
    title = base[:31]
    index = 2
    while title.casefold() in {name.casefold() for name in workbook.sheetnames}:
        suffix = f' {index}'
        title = base[:31-len(suffix)] + suffix
        index += 1
    return title


def selected_profiles(report):
    selection = report.get('selection') or {}
    profiles = (report.get('data') or {}).get('profiles') or []
    selected = selection.get('profiles') or []
    if not selected or not profiles or {str(p.get('id')) for p in profiles} != set(selected):
        raise ValueError('Les profils calculés ne correspondent pas à la sélection de la synthèse.')
    return profiles


def selected_columns(profile, selection):
    columns = profile.get('columns') or []
    expected = set(selection.get('scenarios') or [])
    if profile.get('id') in ('Customer', 'CustomerWO'):
        expected.discard('baseLib')  # This scenario exists only in the PIE report.
    if not columns or {c.get('key', (c.get('scenario') or {}).get('key')) for c in columns} != expected:
        raise ValueError('Les colonnes calculées ne correspondent pas aux scénarios sélectionnés.')
    return columns


def dm_values(column):
    c = column
    n = lambda value: number(value) or 0.0
    values = {6:c['autonomy'], 8:c['capacity'], 10:n(c['startSoc'])/100, 11:n(c['minSoc'])/100,
              13:c['gross'], 15:c['vehicleCount'], 16:c['vehicleUnit'], 17:c['vehicleTotal'],
              44:c['available'], 46:n(c['instantaneous'])/1000, 47:c['sleepCurrentEnergy'],
              49:c['wakePeriod'], 50:c['wakeDuration'], 51:c['wakeCurrent'],
              52:c['balancingDuration'], 53:c['balancingCurrent'], 54:c['technicalWake'],
              64:c['sleep']['alarm'],65:c['alarmEnergy'],67:c['sleep']['sansEbdu'],68:c['sansEbduEnergy'],
              74:c['twtSingleEnergy'],84:c['twtSingleEnergy'],89:n(c['sleep']['agingSoc'])/100,
              90:c['agingEnergy'],92:c['dailyTotal']}
    for key, rows in {'pcuRam':(26,27,28),'cdcRam':(30,31,32),'ivc3':(34,35,36)}.items():
        entry = c['fixed']['entries'][key]
        values.update(zip(rows, (entry['current'],entry['duration'],c['fixedEnergies'][key])))
    entry = c['fixed']['entries']['cellBalancing']
    values.update({19:entry.get('extra',{}).get('periodMin',480),20:entry['current'],21:entry['duration'],
                   23:entry.get('extra',{}).get('balancingDays',90),24:c['fixedEnergies']['cellBalancing']})
    balancing_days = n(values[23])
    values[22] = n(values[24])/balancing_days if balancing_days else 0
    entry = c['fixed']['entries']['transport']
    values.update({39:entry['current'],40:n(entry['current'])/1000*24,41:entry['duration'],42:c['fixedEnergies']['transport']})
    twt = c['sleep']['twt']['single']
    values.update({71:twt.get('ivcCurrent',0),72:twt.get('powerlatchCurrent',0),73:twt.get('durationSeconds',0)})
    # These legacy template cases are not used by the application's DM calculation.
    values.update({row:0 for row in [57,58,59,60,61,62,75,76,77,78,79,80,81,82,83,86,87]})
    fixed_rows = {'cellBalancing':range(19,25),'pcuRam':range(26,29),'cdcRam':range(30,33),'ivc3':range(34,37),'transport':range(39,43)}
    included = {'cellBalancing','pcuRam','transport'}
    if c['scenario']['key'] == 'withoutAlarmTachy':
        included.update({'cdcRam','ivc3'})
    included.difference_update(c.get('deletedFixed') or [])
    for key,rows in fixed_rows.items():
        if key not in included:
            values.update({row:0 for row in rows})
    for key,rows in {'alarm':[64,65],'sansEbdu':[67,68],'twt':list(range(71,85)),'aging':[89,90]}.items():
        if key in (c.get('deletedSleep') or []):
            values.update({row:0 for row in rows})
    return {row: number(value) for row,value in values.items()}


def fill_delivery(sheet, profile, mode, columns):
    # Keep native template positions so dependent sheets retain valid references.
    for col in range(5, sheet.max_column+1):
        sheet.column_dimensions[get_column_letter(col)].hidden = True
    for column in columns:
        key = column['scenario']['key']
        col = 5 if key == 'baseLab' else 7
        sheet.column_dimensions[get_column_letter(col)].hidden = False
        for row, value in dm_values(column).items():
            sheet.cell(row,col,number(value))
        text(sheet.cell(4,col),column['scenario']['label'])
    text(sheet['A6'],f'Autonomie {mode} - {profile["name"]}')
    sheet['A6'].alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)
    sheet['A6'].font = Font(name='Arial', size=12, bold=True, color='1F4E78')
    sheet.row_dimensions[6].height = 54
    text(sheet['E2'],f'{profile["capacity"]} Ah')
    sheet.freeze_panes = 'E8'
    text(sheet.cell(97,2),'Consommations fixes totales (Ah)')
    text(sheet.cell(98,2),'Fonctions de veille personnalisées (Ah/j)')
    end_row = 98
    for column in columns:
        col = 5 if column['scenario']['key'] == 'baseLab' else 7
        sheet.cell(97,col,number(column['fixedTotal']))
        sheet.cell(98,col,number(column['customSleepEnergy']))
        row = 100
        for entry in column['fixed']['custom']:
            text(sheet.cell(row,2),entry.get('name') or 'Fonction fixe personnalisée')
            text(sheet.cell(row,3),f"{entry.get('current',0)} mA - {entry.get('duration',0)} {entry.get('unit','h')}")
            row += 1
        for entry in column.get('customSleep') or []:
            text(sheet.cell(row,2),entry.get('name') or 'Fonction de veille personnalisée')
            sheet.cell(row,col,number(entry['current'])/1000*24)
            row += 1
        end_row=max(end_row,row)
    sheet.print_area = f'A1:I{end_row}' 


def fill_logistic(sheet, rows, profile, mode):
    # The hidden original remains the formula dependency; the visible copy owns
    # the project's selected ECU currents instead of the template's sample data.
    for merged in list(sheet.merged_cells.ranges):
        sheet.unmerge_cells(str(merged))
    sheet.delete_rows(1, sheet.max_row)
    text(sheet.cell(1,1),f'{mode} - {profile["name"]} - {profile["capacity"]} Ah')
    sheet.merge_cells('A1:H1')
    sheet['A1'].font=Font(size=14,bold=True,color='1F4E78')
    sheet['A1'].alignment=Alignment(vertical='center',wrap_text=True)
    sheet.row_dimensions[1].height=36
    headers=['ECU','Courant (µA)']+[f'Jour {day} (µA)' for day in range(1,91)]
    for column,label in enumerate(headers,1):
        text(sheet.cell(3,column),label)
        sheet.cell(3,column).font=Font(bold=True,color='FFFFFF')
        sheet.cell(3,column).fill=PatternFill('solid',fgColor='1F4E78')
    for index,device in enumerate(rows,4):
        text(sheet.cell(index,1),device['name'])
        sheet.cell(index,1).alignment=Alignment(vertical='top',wrap_text=True)
        sheet.row_dimensions[index].height=max(24,math.ceil(len(device['name'])/42)*15)
        current=number(device['currentUa'])
        sheet.cell(index,2,current)
        for column,coefficient in enumerate(device['coefficients'],3):
            sheet.cell(index,column,current*number(coefficient))
    total_row=4+len(rows)
    text(sheet.cell(total_row,1),'Total courant de veille (µA)')
    for column in range(2,93):
        sheet.cell(total_row,column,sum(number(sheet.cell(row,column).value) or 0 for row in range(4,total_row)))
    sheet.column_dimensions['A'].width=48
    for column in range(2,93):sheet.column_dimensions[get_column_letter(column)].width=20
    sheet.freeze_panes='C4'
    sheet.sheet_view.showGridLines=False
    sheet.print_area=f'A1:CN{total_row}'
    sheet.page_setup.orientation='landscape'
    sheet.page_setup.fitToWidth=1
    sheet.page_setup.fitToHeight=0
    sheet.print_title_rows='1:3'


def populate_consoveille(workbook, reports, project):
    bib_source = next((s.title for s in workbook if s.title.casefold().startswith('biberonnage_23')), None)
    related = {'Logistic Mode','Logistic Wo unplug','Delivery','Customer Mode',*CUSTOMER_SHEETS.values()}
    if bib_source:
        related.add(bib_source)
    # Unrelated reference pages always remain visible, including originally hidden pages.
    for sheet in workbook:
        sheet.sheet_state = 'veryHidden' if sheet.title in related else 'visible'
    generated = []
    bib_reports = []
    for report in reports:
        module = report['module']
        if module not in {'dm1','dm2','customer','biberonnage'}:
            continue
        profiles = selected_profiles(report)
        selection = report.get('selection') or {}
        if module in {'dm1','dm2'}:
            mode = module.upper()
            for profile in profiles:
                columns = selected_columns(profile, selection)
                for column in columns:
                    source = 'Logistic Mode' if column['scenario']['key'] == 'baseLab' else 'Logistic Wo unplug'
                    sheet = workbook.copy_worksheet(workbook[source])
                    sheet.title = unique_title(workbook, f'{source} {mode} {profile["name"]}')
                    sheet.sheet_state = 'visible'
                    fill_logistic(sheet, (report.get('data') or {}).get('matrixRows') or [], profile, mode)
                    generated.append(sheet)
                sheet = workbook.copy_worksheet(workbook['Delivery'])
                sheet.title = unique_title(workbook, f'Delivery {mode} {profile["name"]}')
                sheet.sheet_state = 'visible'
                fill_delivery(sheet,profile,mode,columns)
                generated.append(sheet)
        elif module == 'customer':
            workbook['Customer Mode'].sheet_state = 'visible'
            generated.append(workbook['Customer Mode'])
            for profile in profiles:
                if profile['id'] not in CUSTOMER_SHEETS:
                    raise ValueError('Profil Customer inconnu.')
                columns = selected_columns(profile, selection)
                sheet = workbook[CUSTOMER_SHEETS[profile['id']]]
                sheet.sheet_state = 'visible'
                selected = {c['key']:c for c in columns}
                for index,key in enumerate(SCENARIOS,5):
                    letter = get_column_letter(index)
                    sheet.column_dimensions[letter].hidden = key not in selected
                    if key not in selected:
                        continue
                    column = selected[key]
                    text(sheet.cell(4,index),column['label'])
                    for row in CUSTOMER_VALUE_ROWS:
                        sheet.cell(row,index).value = number(column['rows'].get(str(row),column['rows'].get(row)))
                    sheet.cell(6,index,number(column['autonomy']))
                for index in range(10,sheet.max_column+1):
                    sheet.column_dimensions[get_column_letter(index)].hidden = True
                sheet.print_area = 'A1:I121'
                generated.append(sheet)
        else:
            days = (report.get('data') or {}).get('days')
            if days not in (30,90) or days != selection.get('days'):
                raise ValueError('Durée de biberonnage invalide.')
            bib_reports.append((days, profiles))
    if bib_reports:
        sheet = workbook.create_sheet(unique_title(workbook,'Biberonnage 23°'))
        generated.append(sheet)
        row = 1
        for days,profiles in sorted(bib_reports,key=lambda item:item[0]):
            for profile in profiles:
                text(sheet.cell(row,1),f'Biberonnage {days} jours - {profile["name"]}')
                sheet.merge_cells(start_row=row,start_column=1,end_row=row,end_column=14)
                sheet.cell(row,1).font = Font(bold=True,size=14,color='FFFFFF')
                for column in range(1,15):
                    sheet.cell(row,column).fill = PatternFill('solid',fgColor='1F4E78')
                sheet.row_dimensions[row].height = 36
                row += 2
                result = profile['result']
                for label,key in [('Capacité batterie (Ah)','capacityAh'),('SOC de départ (%)','startSoc'),('Conso de veille (Ah)','sumVeilleAh'),('Pertes EF périodiques (Ah)','totalLossL1'),('Pertes EF sur seuil SOC (Ah)','totalLossL2'),('Charge nominale restituée (Ah)','totalRechargeAh'),('Coût EF (Wh)','totalCost'),('Nombre de biberonnages','bibCount')]:
                    text(sheet.cell(row,1),label); sheet.cell(row,2,number(result[key])); row+=1
                row+=1
                headers=['Temps (jours)','SOC batterie (%)','Conso intervalle (Ah)','Pertes EF (Ah)','Charge nominale (Ah)']
                for col,label in enumerate(headers,1):
                    text(sheet.cell(row,col),label);sheet.cell(row,col).font=Font(bold=True,color='1F4E78')
                header_row=row;row+=1
                for index,point in enumerate(profile['timeline']):
                    values=[point['days'], result['socCurrent'][index],result['intervalAh'][index],result['losses'][index],result['recharges'][index]]
                    for col,value in enumerate(values,1):
                        sheet.cell(row,col,number(value))
                    row+=1
                # Keep both points at recharge time, so the sawtooth matches the app.
                points = result['socPoints']
                for index,point in enumerate(points,header_row+1):
                    sheet.cell(index,15,number(point['x']))
                    sheet.cell(index,16,number(point['y']))
                chart=ScatterChart();chart.title=f'SOC batterie - {days} jours';chart.y_axis.title='SOC (%)';chart.x_axis.title='Jours'
                chart.scatterStyle='line'
                chart.x_axis.scaling.min=0
                chart.x_axis.scaling.max=days
                chart.y_axis.scaling.min=0
                chart.y_axis.scaling.max=100
                chart.series.append(Series(
                    Reference(sheet,min_col=16,min_row=header_row+1,max_row=header_row+len(points)),
                    Reference(sheet,min_col=15,min_row=header_row+1,max_row=header_row+len(points)),title='SOC batterie (%)'))
                chart.legend=None
                chart.visible_cells_only=False
                sheet.add_chart(chart,f'G{header_row}')
                row=max(row,header_row+len(points)+1,header_row+16)+3
        for col,width in {'A':42,'B':24,'C':26,'D':23,'E':26}.items():sheet.column_dimensions[col].width=width
        sheet.column_dimensions['O'].hidden=True;sheet.column_dimensions['P'].hidden=True
        sheet.freeze_panes='B4';sheet.sheet_view.showGridLines=False
        sheet.print_options.horizontalCentered=True
        sheet.page_setup.orientation='landscape'
        sheet.page_setup.paperSize=sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth=1
        sheet.page_setup.fitToHeight=0
        sheet.print_area=f'A1:N{row-1}'
        for line in sheet:
            for cell in line:
                cell.alignment=Alignment(vertical='top',wrap_text=True)
                if isinstance(cell.value,(int,float)):cell.number_format='0.0000'
    if generated:
        workbook.active=workbook.index(generated[0])
    workbook.calculation.fullCalcOnLoad=True
    workbook.calculation.forceFullCalc=True
    workbook.calculation.calcMode='auto'
