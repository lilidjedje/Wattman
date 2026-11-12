"""Native, selectable-text A4 reports built from the application's calculated data."""
from collections import defaultdict
from datetime import datetime
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.graphics.shapes import Drawing, Line, PolyLine, Rect, String
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, PageBreak,
    KeepTogether, LongTable, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents
from synthesis_excel import number, selected_profiles, selected_columns, dm_values

INK = colors.HexColor('#17334D')
BLUE = colors.HexColor('#2466A0')
MUTED = colors.HexColor('#607387')
PALE = colors.HexColor('#F2F6FA')
RULE = colors.HexColor('#DCE5EE')
GREEN = colors.HexColor('#16836E')
RED = colors.HexColor('#BD5450')
WIDTH = A4[0] - 36 * mm
MODULE_NAMES = {'dcdc': 'Dimensionnement DCDC', 'wltc': 'Cycles WLTC',
                'dm1': 'Autonomie DM1', 'dm2': 'Autonomie DM2',
                'customer': 'Autonomie Customer Mode', 'biberonnage': 'Biberonnage'}
CUSTOMER_NAMES = {'Customer':'Customer', 'CustomerWO':'Customer sans Unplug', 'CustomerPIE':'Customer PIE'}


def plain(value):
    return str(value if value is not None else '').replace('\u2019', "'").translate(
        str.maketrans({'\u2011':'-', '\u2013':'-', '\u2014':'-', '\u2212':'-'}))


def decimal(value, digits=2, minimum=0):
    if value is None:
        return '-'
    result = number(value)
    text = f'{result:,.{digits}f}'.replace(',', ' ').replace('.', ',')
    if digits > minimum:
        whole, fraction = text.split(',')
        fraction = fraction.rstrip('0').ljust(minimum,'0')
        text = whole + (',' + fraction if fraction else '')
    return text


def current(value, source='µA'):
    if value is None:
        return '-'
    amps = number(value) * {'A':1, 'mA':.001, 'µA':.000001}[source]
    unit = 'A' if abs(amps) >= 1 else 'mA' if abs(amps) >= .001 else 'µA'
    return decimal(amps / {'A':1,'mA':.001,'µA':.000001}[unit],2,2 if unit=='µA' else 0) + ' ' + unit


def quantity(value, unit='', digits=4):
    if unit in ('A','mA','µA'):
        return current(value,unit)
    if unit in ('%','jours'):digits=min(digits,2)
    return decimal(value,digits) + (' ' + unit if unit and value is not None else '')


STYLES = {
    'body': ParagraphStyle('ReportBody',fontName='Helvetica',fontSize=9,leading=13,textColor=INK,spaceAfter=8),
    'small': ParagraphStyle('ReportSmall',fontName='Helvetica',fontSize=8,leading=11,textColor=MUTED,spaceAfter=6),
    'h1': ParagraphStyle('ReportH1',fontName='Helvetica-Bold',fontSize=21,leading=26,textColor=INK,spaceBefore=6,spaceAfter=15,keepWithNext=True),
    'h2': ParagraphStyle('ReportH2',fontName='Helvetica-Bold',fontSize=14,leading=19,textColor=BLUE,spaceBefore=14,spaceAfter=9,keepWithNext=True),
    'h3': ParagraphStyle('ReportH3',fontName='Helvetica-Bold',fontSize=10,leading=14,textColor=INK,spaceBefore=10,spaceAfter=7,keepWithNext=True),
    'cell': ParagraphStyle('ReportCell',fontName='Helvetica',fontSize=8,leading=11,textColor=INK,splitLongWords=True),
    'head': ParagraphStyle('ReportTableHead',fontName='Helvetica-Bold',fontSize=8,leading=11,textColor=colors.white),
    'cover': ParagraphStyle('ReportCover',fontName='Helvetica-Bold',fontSize=32,leading=38,textColor=INK,spaceAfter=18),
    'project': ParagraphStyle('ReportProject',fontName='Helvetica',fontSize=18,leading=24,textColor=BLUE,spaceAfter=24),
}


def paragraph(text, style='body'):
    return Paragraph(escape(plain(text)).replace('\n','<br/>'),STYLES[style])


def table(headers, rows, widths=None):
    data = [[paragraph(value,'head') for value in headers]]
    data += [[paragraph(value,'cell') for value in row] for row in rows]
    result = LongTable(data,colWidths=widths or [WIDTH/len(headers)]*len(headers),
                       repeatRows=1,hAlign='LEFT',splitInRow=1)
    result.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),
        ('LINEBELOW',(0,0),(-1,0),.6,INK),
        ('LINEBELOW',(0,1),(-1,-1),.25,RULE),
    ]))
    return result


class ReportDocument(BaseDocTemplate):
    def __init__(self, stream, project):
        super().__init__(stream,pagesize=A4,leftMargin=18*mm,rightMargin=18*mm,
                         topMargin=22*mm,bottomMargin=20*mm,
                         title=f"Synthèse électrique - {plain(project.get('name') or 'Wattman')}",
                         author=plain(project.get('pilotWattman') or 'Wattman'),pageCompression=1)
        self.project = plain(project.get('name') or 'Projet Wattman')
        self.addPageTemplates(PageTemplate('report',frames=[Frame(
            self.leftMargin,self.bottomMargin,self.width,self.height,
            leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=self.chrome,onPageEnd=self.context))

    def beforeDocument(self):
        self.module_title='';self.profile_title=''

    def context(self, canvas, doc):
        if not self.module_title:return
        canvas.saveState();canvas.setFillColor(MUTED);canvas.setFont('Helvetica',7)
        label=' / '.join(filter(None,[self.module_title,self.profile_title]))
        while canvas.stringWidth(label,'Helvetica',7)>WIDTH*.58:
            label=label[:-4]+'...'
        canvas.drawRightString(A4[0]-18*mm,A4[1]-13*mm,label)
        canvas.restoreState()

    def chrome(self, canvas, doc):
        canvas.saveState()
        if doc.page > 1:
            canvas.setFillColor(MUTED);canvas.setFont('Helvetica-Bold',8)
            canvas.drawString(18*mm,A4[1]-13*mm,'WATTMAN  /  SYNTHÈSE ÉLECTRIQUE')
            canvas.setStrokeColor(RULE);canvas.line(18*mm,A4[1]-16*mm,A4[0]-18*mm,A4[1]-16*mm)
        canvas.setStrokeColor(RULE);canvas.line(18*mm,15*mm,A4[0]-18*mm,15*mm)
        canvas.setFillColor(MUTED);canvas.setFont('Helvetica',7)
        label=self.project
        while canvas.stringWidth(label,'Helvetica',7)>WIDTH-70:
            label=label[:-4]+'...'
        canvas.drawString(18*mm,10*mm,label)
        canvas.drawRightString(A4[0]-18*mm,10*mm,f'Page {doc.page:02d}')
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if hasattr(flowable,'report_level'):
            text=flowable.getPlainText();key=flowable.report_key
            if flowable.report_level==0:self.module_title=text;self.profile_title=''
            else:self.profile_title=text
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text,key,flowable.report_level,closed=False)
            self.notify('TOCEntry',(flowable.report_level,text,self.page,key))


def vector_chart(series, x_label, y_label, y_kind='A', height=215, bounds=None):
    """Each line, label and grid rule remains vector content in the PDF."""
    drawing=Drawing(WIDTH,height)
    left,right,bottom,top=58,14,44,25
    plot_w,plot_h=WIDTH-left-right,height-bottom-top
    points=[point for item in series for point in item['points'] if point[1] is not None]
    if not points:
        raise ValueError('Le graphique sélectionné ne contient aucune valeur.')
    x_max=max(point[0] for point in points) or 1
    x_min=min(0,min(point[0] for point in points))
    y_min=min(0,min(point[1] for point in points))
    y_max=max(0,max(point[1] for point in points))
    if bounds: y_min,y_max=bounds
    else: y_max += max(y_max-y_min,1e-12)*.08
    if y_max<=y_min:y_max=y_min+1
    sx=lambda x:left+(x-x_min)/(x_max-x_min)*plot_w
    sy=lambda y:bottom+(y-y_min)/(y_max-y_min)*plot_h
    drawing.add(Rect(left,bottom,plot_w,plot_h,fillColor=colors.white,strokeColor=RULE,strokeWidth=.4))
    for index in range(5):
        value=y_min+(y_max-y_min)*index/4;y=sy(value)
        drawing.add(Line(left,y,WIDTH-right,y,strokeColor=RULE,strokeWidth=.4))
        label=current(value,y_kind) if y_kind in ('A','mA','µA') else quantity(value,y_kind,1)
        drawing.add(String(left-8,y-3,label,fontName='Helvetica',fontSize=7,textAnchor='end',fillColor=MUTED))
    for index in range(7):
        value=x_min+(x_max-x_min)*index/6;x=sx(value)
        drawing.add(String(x,bottom-14,decimal(value,1),fontName='Helvetica',fontSize=7,textAnchor='middle',fillColor=MUTED))
    drawing.add(String(left,bottom+plot_h+12,y_label,fontName='Helvetica-Bold',fontSize=8,fillColor=INK))
    drawing.add(String(left+plot_w/2,8,x_label,fontName='Helvetica',fontSize=8,textAnchor='middle',fillColor=MUTED))
    for item in series:
        path=[]
        def draw_path():
            if len(path)>=4:drawing.add(PolyLine(path[:],strokeColor=item['color'],strokeWidth=1.6,fillColor=None))
        for x,y in item['points']:
            if y is None:draw_path();path=[]
            else:path.extend([sx(x),sy(y)])
        draw_path()
    return drawing


class ReportBuilder:
    def __init__(self):
        self.story=[];self.sequence=0

    def heading(self,text,level=0):
        self.sequence+=1
        item=paragraph(text,'h1' if level==0 else 'h2')
        item.report_level=level;item.report_key=f'section-{self.sequence}'
        self.story.append(item)

    def section(self,title):
        self.story.append(PageBreak());self.heading(title)

    def parameters(self,headers,rows):
        for start in range(0,len(headers),5):
            chosen=headers[start:start+5]
            description=.43 if len(chosen)<4 else .36
            widths=[WIDTH*description]+[WIDTH*(1-description)/len(chosen)]*len(chosen)
            self.story.append(table(['Paramètre',*chosen],
                [[label,*values[start:start+5]] for label,values in rows],widths))
            self.story.append(Spacer(1,10))

    def ecus(self,rows):
        if not rows:return
        self.story.append(paragraph('Courants des ECU sélectionnés','h3'))
        data=[[row['name'],current(row['currentUa']),current(row.get('technicalWakeupA',0),'A'),
               current(row.get('smartmosUa',0)),current(row.get('totalDarkCurrentUa',
               number(row['currentUa'])+number(row.get('technicalWakeupA',0))*1e6+number(row.get('smartmosUa',0))))] for row in rows]
        self.story.append(table(['ECU','Current','Technical Wakeup','SmartMOS','Total Dark Current'],data,
                                [WIDTH*.36]+[WIDTH*.16]*4))
        self.story.append(Spacer(1,12))

    def sizing(self,report):
        module=report['module']
        configuration=(report['data'].get('configuration') or {}).get('name')
        self.section(MODULE_NAMES[module]+(' · '+configuration if configuration else ''))
        profiles=[('winter','Winter'),('midseason','Mid-season'),('summer','Summer')] if module=='dcdc' else [(f'cycle{i}',f'Cycle {i}') for i in range(1,4)]
        for key,label in profiles:
            records=(report['data'].get('synthesis') or {}).get(module,{}).get(key) or []
            if not records:raise ValueError(f'Les données du profil {label} sont absentes.')
            series=[{'label':name,'color':color,'points':[(number(row['time']),number(row[field])) for row in records]}
                    for field,name,color in [('base','Base véhicule',BLUE),('upper','Upper véhicule',GREEN),('dcdcOutput','Sortie DCDC',RED)]]
            legend=table([item['label'] for item in series],[[f"Pic : {current(max(y for _x,y in item['points']),'A')}" for item in series]])
            legend.setStyle(TableStyle([('BACKGROUND',(i,0),(i,0),item['color']) for i,item in enumerate(series)]))
            self.story.append(KeepTogether([paragraph(label,'h2'),vector_chart(series,'Temps (min)','Courant'),legend,Spacer(1,14)]))

    def dm(self,report):
        configuration=(report['data'].get('configuration') or {}).get('name')
        mode=report['module'].upper();self.section(MODULE_NAMES[report['module']]+(' — Profil : '+configuration if configuration else ''))
        self.ecus(report['data'].get('matrixRows') or [])
        for index,profile in enumerate(selected_profiles(report)):
            if index:self.story.append(PageBreak())
            columns=selected_columns(profile,report['selection'])
            self.heading(profile['name'],1)
            labels=[column['scenario']['label'] for column in columns]
            specs=[('Autonomie','autonomy','jours'),('Capacité batterie','capacity','Ah'),
                   ('SOC de départ','startSoc','%'),('SOC minimal','minSoc','%'),
                   ('Énergie disponible','available','Ah'),('Courant de veille','instantaneous','µA'),
                   ('Consommation journalière','dailyTotal','Ah/j')]
            self.parameters(labels,[(label,[quantity(c[key],unit) for c in columns]) for label,key,unit in specs])
            self.story.append(paragraph('Bilan des consommations','h3'))
            specs=[('Énergie brute utilisable','gross','Ah'),('Endormissements véhicule','vehicleTotal','Ah'),
                   ('Consommations forfaitaires','fixedTotal','Ah'),('Veille des ECU','sleepCurrentEnergy','Ah/j'),
                   ('Réveils techniques','technicalWake','Ah/j'),('Alarme','alarmEnergy','Ah/j'),
                   ('Sans e-BDU','sansEbduEnergy','Ah/j'),('TWT','twtSingleEnergy','Ah/j'),
                   ('Vieillissement batterie','agingEnergy','Ah/j'),('Fonctions de veille ajoutées','customSleepEnergy','Ah/j')]
            self.parameters(labels,[(label,[quantity(c[key],unit) for c in columns]) for label,key,unit in specs])
            self.story.append(paragraph('Paramètres détaillés','h3'))
            specs=[(15,'Nombre d’endormissements',''),(16,'Énergie par endormissement','Ah'),
                   (19,'Cell balancing - période','min'),(20,'Cell balancing - courant','mA'),(21,'Cell balancing - durée','s'),(23,'Cell balancing - jours actifs','jours'),
                   (26,'PCU RAM - courant','mA'),(27,'PCU RAM - durée','h'),(30,'CDC RAM - courant','mA'),(31,'CDC RAM - durée','h'),
                   (34,'IVC3 - courant','mA'),(35,'IVC3 - durée','h'),(39,'Transport - courant','mA'),(41,'Transport - durée','jours'),
                   (49,'Réveils techniques - période','h'),(50,'Réveils techniques - durée','s'),(51,'Réveils techniques - courant','mA'),
                   (52,'Réveil équilibrage - durée','s'),(53,'Réveil équilibrage - courant','mA'),
                   (64,'Alarme - courant','mA'),(67,'Sans e-BDU - courant','mA'),(71,'TWT - courant IVC','mA'),(72,'TWT - courant Powerlatch','mA'),(73,'TWT - durée','s')]
            values=[dm_values(c) for c in columns]
            self.parameters(labels,[(name,[quantity(v.get(row),unit) for v in values]) for row,name,unit in specs])
            for column in columns:
                extras=[]
                for entry in column['fixed'].get('custom') or []:
                    extras.append([entry.get('name') or 'Fonction ajoutée',current(entry['current'],'mA'),quantity(entry['duration'],entry.get('unit','h')),quantity(entry.get('energy'),'Ah')])
                for entry in column.get('customSleep') or []:
                    extras.append([entry.get('name') or 'Fonction de veille ajoutée',current(entry['current'],'mA'),'Continue',quantity(number(entry['current'])/1000*24,'Ah/j')])
                if extras:
                    self.story.append(paragraph(f"Fonctions ajoutées - {column['scenario']['label']}",'h3'))
                    self.story.append(table(['Fonction','Courant','Durée','Consommation'],extras,[WIDTH*.4,WIDTH*.2,WIDTH*.2,WIDTH*.2]))

    def customer(self,report):
        configuration=(report['data'].get('configuration') or {}).get('name')
        self.section(MODULE_NAMES['customer']+(' — Profil : '+configuration if configuration else ''));self.ecus(report['data'].get('matrixRows') or [])
        for index,profile in enumerate(selected_profiles(report)):
            if index:self.story.append(PageBreak())
            columns=selected_columns(profile,report['selection'])
            self.heading(CUSTOMER_NAMES[profile['id']],1)
            labels=[column['label'] for column in columns]
            self.parameters(labels,[('Autonomie',[quantity(c['autonomy'],'jours') for c in columns])])
            for title,specs in CUSTOMER_PARAMETERS:
                self.story.append(paragraph(title,'h3'))
                self.parameters(labels,[(label,[quantity(number(c['rows'].get(str(row),c['rows'].get(row)))*factor if c['rows'].get(str(row),c['rows'].get(row)) is not None else None,unit) for c in columns]) for row,label,unit,factor in specs])

    def biberonnage(self,reports):
        self.section(MODULE_NAMES['biberonnage'])
        first=True
        for report in sorted(reports,key=lambda item:item['data']['days']):
            days=report['data']['days']
            if days not in (30,90) or days!=report['selection']['days']:raise ValueError('Durée de biberonnage invalide.')
            for profile in selected_profiles(report):
                if not first:self.story.append(PageBreak())
                first=False
                configuration=(report['data'].get('configuration') or {}).get('name')
                self.heading((f"Profil : {configuration} — " if configuration else '')+f"{profile['name']} - {days} jours",1)
                result=profile['result'];config=profile['config']
                stats=[('Capacité batterie','capacityAh','Ah'),('SOC de départ','startSoc','%'),
                       ('Consommation de veille','sumVeilleAh','Ah'),('Pertes périodiques','totalLossL1','Ah'),
                       ('Pertes sur seuil SOC','totalLossL2','Ah'),('Charge nominale restituée','totalRechargeAh','Ah'),
                       ('Coût énergétique EF','totalCost','Wh'),('Nombre de biberonnages','bibCount','')]
                self.story.append(table(['Indicateur','Résultat'],[[label,quantity(result[key],unit)] for label,key,unit in stats],[WIDTH*.6,WIDTH*.4]))
                self.story.append(Spacer(1,12))
                self.story.append(KeepTogether([paragraph('Évolution du SOC batterie','h3'),vector_chart([
                    {'label':'SOC batterie','color':BLUE,'points':[(number(p['x']),number(p['y'])) for p in result['socPoints']]}],
                    'Temps (jours)','SOC batterie (%)','%',225,(0,100))]))
                self.story.append(paragraph('Paramètres de recharge','h3'))
                params=[('Seuil de demande EF','efDemandSoc','%'),('SOC cible','targetSoc','%'),('Période de recharge','frequencyDays','jours'),
                        ('Courant système périodique','consoL1','A'),('Durée périodique','durationL1','min'),
                        ('Courant système sur seuil','consoL2','A'),('Durée sur seuil','durationL2','min'),
                        ('Acceptance périodique','acceptanceL1','A'),('Acceptance sur seuil','acceptanceL2','A')]
                self.story.append(table(['Paramètre','Valeur'],[[label,quantity(config.get(key),unit)] for label,key,unit in params],[WIDTH*.6,WIDTH*.4]))
                inputs=profile.get('inputRows') or []
                if inputs:
                    self.story.append(paragraph('Fonctions retenues','h3'))
                    self.story.append(table(['Fonction','Courant / valeur maximale'],[[row['name'],quantity(max(number(v) for v in row['values'].values()),row['unit'])] for row in inputs],[WIDTH*.65,WIDTH*.35]))
                self.story.append(paragraph('Chronologie de consommation et de recharge','h3'))
                rows=[[quantity(point['days'],'',1),quantity(result['socCurrent'][i],'%'),quantity(result['intervalAh'][i],'Ah'),quantity(result['losses'][i],'Ah'),quantity(result['recharges'][i],'Ah')] for i,point in enumerate(profile['timeline'])]
                self.story.append(table(['Jour','SOC batterie','Consommation','Pertes EF','Charge nominale'],rows))


def specs(rows):
    return [(*item,1) if len(item)==3 else tuple(item) for item in rows]


CUSTOMER_PARAMETERS = [
    ('Batterie et bilan',specs([(8,'Capacité batterie','Ah'),(10,'SOC de départ','%',100),(11,'SOC minimal','%',100),(13,'Énergie brute utilisable','Ah'),(15,'Nombre d’endormissements',''),(16,'Énergie par endormissement','Ah'),(17,'Énergie d’endormissement','Ah'),(86,'Énergie disponible en début de veille','Ah'),(121,'Consommation journalière totale','Ah/j')])),
    ('Fonctions forfaitaires',specs([(19,'Cell balancing - période','min'),(20,'Cell balancing - courant','mA'),(21,'Cell balancing - durée','s'),(22,'Cell balancing - consommation journalière','Ah/j'),(23,'Cell balancing - jours actifs','jours'),(24,'Cell balancing - énergie totale','Ah'),
        (26,'PCU RAM - courant','mA'),(27,'PCU RAM - durée','h'),(28,'PCU RAM - énergie','Ah'),(30,'PCU Secure reboot - courant','mA'),(31,'PCU Secure reboot - durée','s'),(32,'PCU Secure reboot - énergie','Ah'),(34,'CDC RAM - courant','mA'),(35,'CDC RAM - durée','h'),(36,'CDC RAM - énergie','Ah'),
        (38,'CDC Garage - courant','mA'),(39,'CDC Garage - durée','min'),(40,'CDC Garage - énergie','Ah'),(42,'CDC Secure reboot - courant','mA'),(43,'CDC Secure reboot - durée','min'),(44,'CDC Secure reboot - énergie','Ah'),
        (46,'Smart Antenna MQTT - courant','mA'),(47,'Smart Antenna MQTT - consommation journalière','Ah/j'),(48,'Smart Antenna MQTT - jours','jours'),(49,'Smart Antenna MQTT - énergie','Ah'),(50,'Smart Antenna DRX - courant','mA'),(51,'Smart Antenna DRX - consommation journalière','Ah/j'),(52,'Smart Antenna DRX - jours','jours'),(53,'Smart Antenna DRX - énergie','Ah'),(54,'Smart Antenna Remote - énergie','Ah'),(55,'Smart Antenna - énergie totale','Ah'),
        (57,'FOTA - courant','mA'),(58,'FOTA - durée','min'),(59,'FOTA - énergie','Ah'),(61,'TEST - courant','mA'),(62,'TEST - consommation journalière','Ah/j'),(63,'TEST - jours','jours'),(64,'TEST - énergie','Ah'),
        (66,'Hand Free - courant initial','mA'),(67,'Hand Free - consommation initiale','Ah/j'),(68,'Hand Free - jours initiaux','jours'),(69,'Hand Free - énergie initiale','Ah'),(71,'Hand Free - courant suivant','mA'),(72,'Hand Free - consommation suivante','Ah/j'),(73,'Hand Free - jours suivants','jours'),(74,'Hand Free - énergie suivante','Ah'),
        (76,'Premières 8 h - courant','mA'),(77,'Premières 8 h - courant converti','A'),(78,'Premières 8 h - durée','h'),(79,'Premières 8 h - énergie','Ah'),(81,'BLM - courant','mA'),(82,'BLM - consommation journalière','Ah/j'),(83,'BLM - jours','jours'),(84,'BLM - énergie','Ah')])),
    ('Veille et réveils techniques',specs([(88,'Courant de veille','mA'),(89,'Veille des ECU','Ah/j'),(91,'Réveils techniques - période','h'),(92,'Réveils SOC - durée','s'),(93,'Réveils SOC - courant','mA'),(94,'Réveils équilibrage - durée','s'),(95,'Réveils équilibrage - courant','mA'),(96,'Réveils techniques - consommation','Ah/j'),
        (99,'TWT - période','h'),(100,'TWT IVC - durée','s'),(101,'TWT IVC - courant','mA'),(102,'TWT Powerlatch - durée','s'),(103,'TWT Powerlatch - courant','mA'),(104,'TWT - consommation','Ah/j'),(106,'Sans e-BDU - courant','mA'),(107,'Sans e-BDU - consommation','Ah/j'),(109,'Alarme - courant','mA'),(110,'Alarme - consommation','Ah/j'),(112,'AID - courant','mA'),(113,'AID - consommation','Ah/j'),(115,'Tachymètre - courant','mA'),(116,'Tachymètre - consommation','Ah/j'),(118,'Vieillissement SOC','%',100),(119,'Vieillissement - consommation','Ah/j')]))
]


def build_synthesis_pdf(payload):
    if not isinstance(payload,dict):raise ValueError('Les paramètres du rapport PDF sont invalides.')
    modules=payload.get('modules') or [];reports=payload.get('reports') or []
    if not isinstance(modules,list) or not modules or any(not isinstance(m,str) or m not in MODULE_NAMES for m in modules) or len(set(modules))!=len(modules):
        raise ValueError('La sélection des rapports PDF est invalide.')
    if not isinstance(reports,list) or not reports or any(not isinstance(r,dict) or not isinstance(r.get('module'),str) or not isinstance(r.get('data'),dict) for r in reports) or {r['module'] for r in reports}!=set(modules):
        raise ValueError('Les données des rapports sélectionnés sont absentes.')
    grouped=defaultdict(list)
    for report in reports:grouped[report['module']].append(report)
    if any(len(items)>1 for key,items in grouped.items() if key not in ('biberonnage','dcdc','wltc')):
        raise ValueError('Un rapport a été sélectionné plusieurs fois.')
    project=payload.get('project') or {};builder=ReportBuilder();story=builder.story
    story += [Spacer(1,26*mm),paragraph('WATTMAN  /  INGÉNIERIE ÉLECTRIQUE','small'),Spacer(1,10*mm),
              paragraph('Synthèse électrique\net autonomie','cover'),paragraph(project.get('name') or 'Projet Wattman','project')]
    metadata=[]
    for label,key in [('Date du projet','date'),('Pilote Wattman','pilotWattman')]:
        if project.get(key):metadata.append([label,plain(project[key])])
    metadata.append(['Date du rapport',payload.get('generatedDate') or datetime.now().strftime('%d/%m/%Y')])
    story += [table(['Projet','Informations'],metadata,[WIDTH*.32,WIDTH*.68]),Spacer(1,14*mm),paragraph('Périmètre du rapport','h2')]
    for module in MODULE_NAMES:
        if module not in modules:continue
        items=grouped[module]
        count=len({str(p['id']) for item in items for p in (item.get('data') or {}).get('profiles') or []})
        label=MODULE_NAMES[module]+(f" - {count} profil{'s' if count>1 else ''}" if count else ' - 3 cycles' if module=='wltc' else ' - 3 profils de charge')
        if module in ('dcdc','wltc'):
            label=MODULE_NAMES[module]+f" - {len(items)} configuration{'s' if len(items)>1 else ''}, 3 {'cycles' if module=='wltc' else 'saisons'} chacune"
        story.append(paragraph(label))
    story += [PageBreak(),paragraph('Sommaire','h1')]
    toc=TableOfContents();toc.levelStyles=[
        ParagraphStyle('TOCModule',fontName='Helvetica-Bold',fontSize=10,leading=16,textColor=INK,spaceBefore=9,leftIndent=0,rightIndent=18),
        ParagraphStyle('TOCProfile',fontName='Helvetica',fontSize=9,leading=14,textColor=MUTED,leftIndent=12,rightIndent=18)]
    story.append(toc)
    for module in MODULE_NAMES:
        if module not in modules:continue
        if module in ('dcdc','wltc'):
            for report in grouped[module]:builder.sizing(report)
        elif module in ('dm1','dm2'):builder.dm(grouped[module][0])
        elif module=='customer':builder.customer(grouped[module][0])
        else:builder.biberonnage(grouped[module])
    output=BytesIO();document=ReportDocument(output,project)
    document.multiBuild(story)
    return output.getvalue()
