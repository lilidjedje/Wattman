/* Presentation only: application models and Excel keep their original units. */
(function (global) {
    'use strict';
    const factors = { A: 1, mA: 1e-3, 'µA': 1e-6 };
    const unit = value => String(value || '').replace(/[μu]A/g, 'µA').trim();
    const normalize = value => String(value ?? '').replace(/\s/g, '').replace(',', '.');
    function isUnit(text) { return Object.hasOwn(factors, unit(text)); }
    const numeric = value => Number(normalize(value));
    function parts(value, sourceUnit = 'A') {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const amps = numeric(value) * factors[unit(sourceUnit)];
        if (!Number.isFinite(amps)) return null;
        const magnitude = Math.abs(amps);
        const selected = magnitude >= 1 ? 'A' : magnitude >= .001 ? 'mA' : 'µA';
        return { value: amps / factors[selected], unit: selected, amps };
    }
    function format(value, sourceUnit = 'A') {
        const result = parts(value, sourceUnit);
        if (!result) return '—';
        const text = new Intl.NumberFormat('fr-FR', {
            minimumFractionDigits: result.unit === 'µA' ? 2 : 0,
            maximumFractionDigits: 2
        }).format(Object.is(result.value, -0) ? 0 : result.value);
        return `${text} ${result.unit}`;
    }
    global.CurrentUnits = { parts, format, isUnit, normalize };
    if (!global.document) return;

    const document = global.document;
    const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const bindings = new WeakMap();
    const suffixSelector = '.battery-unit-suffix,.matrix-current-unit-suffix,.matrix-current-suffix,.matrix-current-unit-label,.battery-unit-label,.current-unit';
    const currentUnit = /(?:^|[\s(])([µμu]A|mA|A)(?=$|[\s)])/;
    function labelUnit(text) {
        const match=text.match(currentUnit);
        if (!match) return null;
        // "Canal A" identifies hardware, not an ampere value (frequency/duration forms).
        if (match[1]==='A' && !/current|courant|conso|wakeup|smartmos|dark/i.test(text)
            && !/\(A\)/.test(text) && text.trim()!=='A') return null;
        return match[1];
    }
    function bind(input, baseUnit, suffix) {
        if (bindings.has(input) || !isUnit(baseUnit)) return;
        baseUnit = unit(baseUnit);
        const state = { canonical: input.dataset.currentCanonicalValue ?? valueProperty.get.call(input), displayUnit: baseUnit,
            minimum: input.dataset.currentOriginalMin ?? input.getAttribute('min'),
            maximum: input.dataset.currentOriginalMax ?? input.getAttribute('max') };
        bindings.set(input, state);
        input.dataset.currentBaseUnit = baseUnit;
        if(state.minimum !== null) input.dataset.currentOriginalMin=state.minimum;
        if(state.maximum !== null) input.dataset.currentOriginalMax=state.maximum;
        function show() {
            input.dataset.currentCanonicalValue = state.canonical;
            const result = state.canonical.trim() === '' ? null : parts(state.canonical, baseUnit);
            state.displayUnit = result?.unit || 'µA';
            if (result) {
                // Do not round the model: only the native, painted input value.
                const shown = result.unit === 'µA' ? result.value.toFixed(2) : String(Number(result.value.toFixed(2)));
                valueProperty.set.call(input, shown);
            } else valueProperty.set.call(input, '');
            if (suffix) suffix.textContent = state.displayUnit;
            if (input.parentElement?.hasAttribute('data-unit')) input.parentElement.dataset.unit = state.displayUnit;
            input.dataset.currentDisplayUnit = state.displayUnit;
            input.step = '0.01';
            for (const [name, bound] of [['min',state.minimum],['max',state.maximum]]) {
                if (bound !== null) input.setAttribute(name, numeric(bound) * factors[baseUnit] / factors[state.displayUnit]);
            }
        }
        Object.defineProperty(input, 'value', {
            configurable: true, get: () => state.canonical,
            set: value => { state.canonical = String(value ?? ''); show(); }
        });
        Object.defineProperty(input, 'valueAsNumber', {
            configurable: true, get: () => state.canonical === '' ? NaN : numeric(state.canonical),
            set: value => { state.canonical = Number.isNaN(value) ? '' : String(value); show(); }
        });
        input.addEventListener('input', () => {
            const typed = valueProperty.get.call(input);
            if (!typed.trim() || !Number.isFinite(numeric(typed))) {
                state.canonical = ''; input.dataset.currentCanonicalValue=''; return;
            }
            const source = numeric(typed) * factors[state.displayUnit] / factors[baseUnit];
            state.canonical = String(Number(source.toPrecision(15)));
            input.dataset.currentCanonicalValue = state.canonical;
            const next = parts(state.canonical, baseUnit);
            if (next.unit !== state.displayUnit) show();
            else if ((typed.split(/[.,]/)[1] || '').length > 2) {
                valueProperty.set.call(input,String(Number(next.value.toFixed(2))));
            }
        }, true);
        input.addEventListener('blur',show);
        input.form?.addEventListener('formdata', event => {
            if (input.name && !input.disabled) event.formData.set(input.name, state.canonical);
        });
        input.form?.addEventListener('reset', () => {
            state.canonical = input.defaultValue;
            input.dataset.currentCanonicalValue=state.canonical;
            queueMicrotask(show);
        });
        show();
    }
    global.CurrentUnits.displayValue = input => valueProperty.get.call(input);
    global.CurrentUnits.bind = bind;

    function inputUnit(input) {
        if (input.dataset.currentBaseUnit) return input.dataset.currentBaseUnit;
        const parent = input.parentElement;
        if (isUnit(parent?.dataset.unit)) return parent.dataset.unit;
        const suffix = parent?.querySelector(suffixSelector);
        if (suffix && isUnit(suffix.textContent)) return suffix.textContent;
        const label = input.closest('label');
        return label ? labelUnit(label.textContent) : null;
    }
    function attach(input, baseUnit) {
        if (!baseUnit || !isUnit(baseUnit) || input.matches('[type=checkbox],[type=radio],[type=hidden]')) return;
        let suffix = input.parentElement?.querySelector(suffixSelector);
        if (!suffix && !input.parentElement?.hasAttribute('data-unit')) {
            suffix = document.createElement('span'); suffix.className = 'current-unit';
            suffix.style.cssText = 'margin-left:6px;white-space:nowrap;font-weight:600';
            input.after(suffix);
        }
        bind(input, baseUnit, suffix);
    }
    function formatCell(cell, baseUnit) {
        if (cell.querySelector('input,select,textarea') || cell.children.length || !cell.textContent.trim()) return;
        const value = cell.textContent.trim();
        if (!/^[+−-]?[\d\s.,]+(?:e[+-]?\d+)?$/i.test(value)) return;
        cell.textContent = format(value.replace('−','-'), baseUnit);
    }
    const paintedText = new WeakMap();
    function scan(root = document) {
        root.querySelectorAll('input').forEach(input => attach(input,inputUnit(input)));
        root.querySelectorAll('table').forEach(table => {
            const grid = [];
            [...(table.tHead?.rows || [])].forEach((row,r) => {
                grid[r] ||= []; let column = 0;
                [...row.cells].forEach(header => {
                    while (grid[r][column] !== undefined) column++;
                    const headerText = [...header.childNodes].map(node=>node.textContent).join(' ');
                    const match = headerText.match(currentUnit);
                    const base = header.dataset.currentBaseUnit || labelUnit(headerText);
                    if (base) {
                        header.dataset.currentBaseUnit = base;
                        // Each value now carries its own unit; a fixed column label would be misleading.
                        if (match) header.textContent = headerText.replace(/\s*\(([µμu]A|mA|A)\)/g,'').replace(currentUnit,' ').trim();
                    }
                    for (let y=r;y<r+header.rowSpan;y++) {
                        grid[y] ||= [];
                        for(let x=column;x<column+header.colSpan;x++) grid[y][x]={base};
                    }
                    column+=header.colSpan;
                });
            });
            const columns = (grid.at(-1) || []).map(cell=>cell?.base);
            [...table.tBodies].forEach(body=>[...body.rows].forEach(row=>{
                [...row.cells].forEach((cell,index)=>{
                    const base = cell.dataset.currentBaseUnit || columns[index];
                    if (!base) return;
                    cell.dataset.currentBaseUnit = base;
                    cell.querySelectorAll('input').forEach(input=>attach(input,base));
                    formatCell(cell,base);
                });
            }));
        });
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        const expressions = /(^|[^\w.,])([+-]?\d[\d \u00a0\u202f]*(?:[.,]\d+)?(?:[eE][+-]?\d+)?)\s*([µμu]A|mA|A)(?![\w/])/g;
        let node;
        while ((node=walker.nextNode())) {
            if (node.parentElement?.closest('script,style,textarea,option,th,[data-unit],.current-unit,.battery-unit-suffix,.matrix-current-unit,.setup-formula')) continue;
            if (paintedText.get(node) === node.data) continue;
            const next=node.data.replace(expressions,(_all,prefix,value,base)=>prefix+format(value,base));
            if(next!==node.data) node.data=next;
            paintedText.set(node,next);
        }
    }
    global.CurrentUnits.refresh = scan;
    function start() {
        const observer = new MutationObserver(()=>{
            observer.disconnect(); scan(); observer.observe(document.body,{childList:true,subtree:true,characterData:true});
        });
        scan();observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start);
    else start();
})(typeof window === 'undefined' ? globalThis : window);
