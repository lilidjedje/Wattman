/* Source interpretation is separate from adaptive display units. */
(() => {
    const factors={A:1,mA:1e-3,uA:1e-6};
    const unit=text=>String(text||'').replace(/[µμ]/g,'u').replace(/\s/g,'');
    function read(row,column,category) {
        const raw=row[column];
        const text=String(raw??'').trim().replace(/\s/g,'').replace(',','.');
        const match=text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([A-Za-zµμ]*)$/i);
        const explicit=unit(match?.[2] || row['Current Unit'] || row['Current unit'] || row['Unit'] || row['Unité']);
        const cat=String(category||row.current_category||row['Current Category']||'').trim().toUpperCase();
        // Generic Current (A) is the legacy Wattman column: its category defines the unit.
        const columnUnit=unit(column.match(/\(([^)]+)\)/)?.[1]);
        const inferred=cat==='S' && /^(Current|Homologation Current) \(A\)$/.test(column) ? 'uA'
            : factors[columnUnit] ? columnUnit : cat==='S'?'uA':'A';
        const sourceUnit=factors[explicit]?explicit:inferred;
        const value=match?Number(match[1]):NaN;
        const amperes=value*factors[sourceUnit];
        const unknownUnit=!!explicit&&!factors[explicit];
        const suspicious=unknownUnit||!Number.isFinite(amperes)||amperes<0||(cat==='H'&&amperes>1000)||(cat==='S'&&amperes>.01);
        return {amperes,microamps:value*({A:1e6,mA:1000,uA:1}[sourceUnit]),unit:sourceUnit,suspicious,
            reason:unknownUnit?'Unité non reconnue : vérifiez la fiche Wattman.':!Number.isFinite(amperes)?'Valeur non numérique':amperes<0?'Courant négatif':suspicious?'Courant inhabituel : vérifiez la valeur et son unité dans la fiche Wattman.':''};
    }
    window.WattmanCurrent={read};
})();
