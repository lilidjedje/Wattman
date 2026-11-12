/*
 * Codes couleurs repris à l'identique des classeurs Excel de référence
 * (Consoveille.xlsx, DCDC.xlsx, excel_templates/*.xlsx).
 *
 * - Styles statiques des feuilles Customer / Delivery (cellules de saisie,
 *   lignes Énergie, énergie disponible, consommation en veille totale).
 * - Mises en forme conditionnelles :
 *   - Autonomie (jours) : fond noir, police blanche, police rouge si < 30 jours.
 *   - Biberonnage : %SOC = 100 -> vert 66FF33, %SOC = 90 -> FFC7CE / 9C0006,
 *     Besoin énergie HT > 1 -> vert 66FF33.
 *   - Bilan DCDC : consommation > sortie DCDC -> orange FFC000,
 *     consommation < sortie DCDC -> vert 00B050 ; activation 0 -> 00B050, 1 -> FFC000.
 *   - Balance charge/décharge : échelle 3 couleurs -0,1 F8696B / 0 FFEB84 / 0,1 63BE7B.
 */
(function (global) {
    'use strict';

    const COLORS = Object.freeze({
        input: '#CCFFFF',          // cellules à documenter
        grossEnergy: '#FFFF99',    // énergie disponible brute (indexed 43)
        availableEnergy: '#CCFFCC',// énergie disponible en début de veille (indexed 42)
        sleepTotal: '#FFF2CC',     // consommation en veille totale (accent 4, teinte 80 %)
        limit: '#FFFF00',          // durées plafonnées (S2RAM, connectivité)
        blmDuration: '#9DC3E6',    // durée BLM (accent 5, teinte 40 %)
        energyFont: '#0000FF',     // police des lignes Énergie (indexed 12)
        redFont: '#FF0000',
        autonomyFill: '#000000',
        autonomyFont: '#FFFFFF',
        socFull: '#66FF33',
        socLowFill: '#FFC7CE',
        socLowFont: '#9C0006',
        dcdcOver: '#FFC000',
        dcdcUnder: '#00B050',
        scaleLow: '#F8696B',
        scaleMid: '#FFEB84',
        scaleHigh: '#63BE7B'
    });

    const AUTONOMY_THRESHOLD_DAYS = 30;

    // Style des cellules de valeurs, par identifiant de ligne du rapport
    // (colonnes E à I des feuilles Customer / Delivery).
    const ROW_CLASSES = {
        capa: 'xl-input', soc_dep: 'xl-input xl-bold', soc_min: 'xl-bold',
        energy_brute: 'xl-energy-gross',
        endor_nbre: 'xl-input xl-bold', endor_energy: 'xl-input', endor_tot: 'xl-energy',
        cb_per: 'xl-input', cb_conso: 'xl-input xl-bold', cb_duree: 'xl-input', cb_ahj: 'xl-bold', cb_dur_bal: 'xl-bold', cb_energy_tot: 'xl-energy',
        pcu_ram_conso: 'xl-input xl-red', pcu_ram_duree: 'xl-limit xl-red', pcu_ram_energy: 'xl-energy',
        pcu_sec_conso: 'xl-input', pcu_sec_duree: 'xl-input', pcu_sec_energy: 'xl-energy',
        cdc_ram_conso: 'xl-input xl-red', cdc_ram_duree: 'xl-limit xl-red', cdc_ram_energy: 'xl-energy',
        ivc3_conso: 'xl-input xl-red', ivc3_duree: 'xl-limit xl-red', ivc3_energy: 'xl-energy',
        cdc_gar_conso: 'xl-input', cdc_gar_duree: 'xl-input', cdc_gar_energy: 'xl-energy',
        cdc_sec_conso: 'xl-input', cdc_sec_duree: 'xl-input', cdc_sec_energy: 'xl-energy',
        transport_conso: 'xl-input', transport_ahj: 'xl-bold', transport_duree: 'xl-input', transport_energy: 'xl-energy',
        sa_mqtt_conso: 'xl-input', sa_mqtt_ahj: 'xl-bold', sa_mqtt_dur: 'xl-limit xl-bold', sa_mqtt_eng: 'xl-energy',
        sa_drx_conso: 'xl-input', sa_drx_ahj: 'xl-bold', sa_drx_dur: 'xl-input xl-bold', sa_drx_eng: 'xl-energy',
        sa_remote_eng: 'xl-energy', sa_tot_eng: 'xl-input xl-energy',
        fota_conso: 'xl-input', fota_energy: 'xl-energy',
        test_conso: 'xl-input', test_ahj: 'xl-bold', test_duree: 'xl-input', test_energy: 'xl-energy',
        hfk3_conso: 'xl-input', hfk3_ahj: 'xl-bold', hfk3_duree: 'xl-input', hfk3_energy: 'xl-energy',
        hfk48_conso: 'xl-input', hfk48_ahj: 'xl-bold', hfk48_duree: 'xl-input', hfk48_energy: 'xl-energy',
        first8_conso: 'xl-input', first8_ah: 'xl-bold', first8_duree: 'xl-input', first8_energy: 'xl-energy',
        blm_conso: 'xl-input', blm_ahj: 'xl-bold', blm_duree: 'xl-blm-duration', blm_energy: 'xl-energy',
        energy_debut_veille: 'xl-energy-available',
        curr_veille_conso: 'xl-input', curr_veille: 'xl-energy',
        rev_tech_period: 'xl-input', rev_tech_soc_duree: 'xl-input', rev_tech_soc_conso: 'xl-input',
        rev_tech_cb_duree: 'xl-input', rev_tech_cb_conso: 'xl-input', rev_tech: 'xl-energy',
        sans_ebdu_conso: 'xl-input', sans_ebdu_cons: 'xl-energy',
        alarme_conso: 'xl-input', alarme: 'xl-energy',
        aid_conso: 'xl-input', aid: 'xl-energy',
        tachy_conso: 'xl-input', tachy: 'xl-energy',
        twt_single_ivc: 'xl-input', twt_single_power: 'xl-input', twt_single_duration: 'xl-input', twt_single_energy: 'xl-energy',
        aging_cons: 'xl-energy',
        veille_tot: 'xl-sleep-total'
    };

    // Feuille Delivery (modes DM) : le bloc « Sans e-BDU s53 » est surligné en jaune.
    const DM_ROW_CLASSES = {
        sans_ebdu_conso: 'xl-limit',
        sans_ebdu_cons: 'xl-limit xl-energy'
    };

    function toNumber(value) {
        if (typeof value === 'number') return value;
        const match = String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : NaN;
    }

    function rowClass(rowId, isDmMode) {
        return (isDmMode && DM_ROW_CLASSES[rowId]) || ROW_CLASSES[rowId] || '';
    }

    function addClassToCells(html, className) {
        if (!className) return html;
        return String(html).replace(/<td\b([^>]*)>/g, (match, attributes) => {
            if (/\bclass\s*=\s*"/.test(attributes)) {
                return `<td${attributes.replace(/\bclass\s*=\s*"/, `class="${className} `)}>`;
            }
            return `<td class="${className}"${attributes}>`;
        });
    }

    function decorateRow(html, rowId, isDmMode) {
        return addClassToCells(html, rowClass(rowId, isDmMode));
    }

    function isAutonomyLow(days) {
        const value = toNumber(days);
        return Number.isFinite(value) && value < AUTONOMY_THRESHOLD_DAYS;
    }

    function autonomyClass(days) {
        return isAutonomyLow(days) ? 'xl-autonomy xl-autonomy-low' : 'xl-autonomy';
    }

    function autonomyCell(content, days = content) {
        return `<td class="${autonomyClass(days)}">${content}</td>`;
    }

    function socClass(soc) {
        const value = toNumber(soc);
        if (!Number.isFinite(value)) return '';
        if (Math.abs(value - 100) < 1e-9) return 'xl-soc-full';
        if (Math.abs(value - 90) < 1e-9) return 'xl-soc-90';
        return '';
    }

    function energyNeedClass(value) {
        const number = toNumber(value);
        return Number.isFinite(number) && number > 1 ? 'xl-soc-full' : '';
    }

    function dcdcLoadClass(value, output) {
        const number = toNumber(value);
        const limit = toNumber(output);
        if (!Number.isFinite(number) || !Number.isFinite(limit)) return '';
        if (number > limit) return 'xl-dcdc-over';
        if (number < limit) return 'xl-dcdc-under';
        return '';
    }

    function activationClass(value) {
        const number = toNumber(value);
        if (number === 1) return 'xl-dcdc-over';
        if (number === 0) return 'xl-dcdc-under';
        return '';
    }

    function hexToRgb(hex) {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    function mix(from, to, ratio) {
        const a = hexToRgb(from), b = hexToRgb(to);
        return '#' + a.map((channel, index) => Math.round(channel + (b[index] - channel) * ratio).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    // Échelle 3 couleurs Excel : min -0,1 / milieu 0 / max 0,1.
    function balanceColor(value) {
        const number = toNumber(value);
        if (!Number.isFinite(number)) return '';
        const clamped = Math.max(-0.1, Math.min(0.1, number));
        return clamped <= 0
            ? mix(COLORS.scaleLow, COLORS.scaleMid, (clamped + 0.1) / 0.1)
            : mix(COLORS.scaleMid, COLORS.scaleHigh, clamped / 0.1);
    }

    global.ExcelColors = Object.freeze({
        COLORS, AUTONOMY_THRESHOLD_DAYS, ROW_CLASSES, DM_ROW_CLASSES,
        toNumber, rowClass, addClassToCells, decorateRow,
        isAutonomyLow, autonomyClass, autonomyCell,
        socClass, energyNeedClass, dcdcLoadClass, activationClass, balanceColor
    });
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.ExcelColors;
