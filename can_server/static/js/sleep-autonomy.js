(() => {
    let chart;
    const number = (value, digits = 3) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('fr-FR', {maximumFractionDigits: digits});
    const html = value => {const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML;};
    const instant = value => value == null ? '—' : new Date(value * 1000).toLocaleString('fr-FR', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3});
    const current = value => value == null ? '—' : `${number(Math.abs(value) * 1000, 6)} mA`;
    const days = value => value == null ? 'Non calculable' : `${number(value, 2)} jours`;
    function difference(item) {
        if (item.difference_days == null) {
            if (!item.covered_s) return 'Données insuffisantes';
            if (item.theoretical_daily_consumption_Ah === 0) return 'Référence à 0 A : autonomie théorique non bornée';
            if (item.daily_consumption_Ah === 0) return 'Courant mesuré nul : autonomie non bornée sur cette observation';
            return 'Comparaison non calculable';
        }
        if (item.status === 'equal') return 'Autonomie équivalente';
        return `Autonomie ${item.status === 'better' ? 'meilleure' : 'moins bonne'} de ${number(Math.abs(item.difference_days), 2)} jours`;
    }
    window.renderSleepAutonomy = (autonomy, startDay, endDay) => {
        const items = autonomy.channels || [];
        document.body.classList.add('autonomy-dashboard');
        document.getElementById('autonomyScope').textContent =
            `Plage analysée : jour ${number(startDay)} à ${number(endDay)}. Jour 0 : ${instant(autonomy.origin_timestamp)}. Les courants théoriques sont calculés à partir des ECU sélectionnés et de leurs profils 0/1.`;
        document.getElementById('autonomySummary').innerHTML = items.map(item => {
            const comparisonClass = item.status === 'better' ? 'autonomy-gain'
                : item.status === 'worse' ? 'autonomy-loss' : '';
            return `<article class="autonomy-result-card">
                <h3>Canal ${html(item.channel)}</h3>
                <p>Autonomie théorique : <strong>${days(item.theoretical_days)}</strong></p>
                <p>Autonomie calculée avec le CAN : <strong>${days(item.days)}</strong></p>
                <p class="${comparisonClass}">${html(difference(item))}</p>
                <p>Durée intégrée : ${number(item.covered_s / 86400, 6)} j (${number(item.covered_s / 3600, 3)} h)</p>
                <small class="coverage-note">${instant(item.first_timestamp)} → ${instant(item.last_timestamp)} · ${number(item.coverage_percent, 3)} % de la plage${item.partial ? ' · couverture partielle' : ''}</small>
            </article>`;
        }).join('');
        if (chart) chart.destroy();
        const canvas = document.getElementById('autonomyComparisonChart');
        canvas.parentElement.style.height = '360px';
        const intervals = items[0]?.intervals || [];
        const labels = intervals.map(row => `Jour ${number(row.start_day, 2)} – ${number(row.end_day, 2)}`);
        const maximumCurrent = Math.max(0, ...items.flatMap(item =>
            (item.intervals || []).flatMap(row => [Math.abs(Number(row.expected_A) || 0), Math.abs(Number(row.average_A) || 0)])
        ));
        const scale = maximumCurrent < 1 ? 1000 : 1;
        const unit = scale === 1000 ? 'mA' : 'A';
        chart = new Chart(canvas, {
            type: 'line', data: {labels, datasets: [
                {
                    label: 'Courant théorique selon les profils',
                    data: intervals.map(row => Number(row.expected_A) * scale),
                    borderColor: '#3b6ee8',
                    backgroundColor: '#3b6ee8',
                    borderWidth: 3,
                    pointRadius: 3,
                    tension: 0,
                    spanGaps: false
                },
                ...items.map((item, index) => ({
                    label: `Courant mesuré CAN — canal ${item.channel}`,
                    data: (item.intervals || []).map(row => row.average_A == null ? null : Number(row.average_A) * scale),
                    borderColor: ['#dc654d', '#219b79'][index % 2],
                    backgroundColor: ['#dc654d', '#219b79'][index % 2],
                    borderWidth: 2,
                    pointRadius: 3,
                    tension: 0,
                    spanGaps: false
                }))
            ]},
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                scales: {
                    x: {title: {display: true, text: 'Jour et plage de profil'}},
                    y: {beginAtZero: true, title: {display: true, text: `Courant (${unit})`},
                        ticks: {callback: value => `${number(value, 3)} ${unit}`}}
                },
                plugins: {
                    legend: {position: 'bottom'},
                    tooltip: {callbacks: {label: context => `${context.dataset.label} : ${number(context.parsed.y, 6)} ${unit}`}}
                }
            }
        });
        document.getElementById('autonomyCoverage').textContent =
            'L’autonomie est calculée avec la même capacité batterie utilisable : capacité / consommation journalière. Les mesures CAN sont intégrées avec leurs horodatages réels ; les périodes sans acquisition ne sont pas assimilées à une consommation nulle. Le courant mesuré affiché par plage est une moyenne pondérée par la durée réellement couverte.';
    };
    window.renderSleepAnomalies = autonomy => {
        const root = document.getElementById('deviceReports');
        root.previousElementSibling.querySelector('h2').textContent = 'Anomalies de consommation en veille';
        const items = (autonomy.channels || []).filter(item => item.anomalies?.length);
        root.innerHTML = items.length ? items.map(item => `<article class="device-report-card"><h3>Anomalies — canal ${html(item.channel)}</h3>
            <p>${html(difference(item))}. Une ligne apparaît dès qu’une mesure CAN dépasse le courant théorique total des profils des ECU sélectionnés. La mesure porte sur la branche ; elle ne permet pas d’attribuer l’écart à un ECU individuel.</p>
            <div class="table-scroll"><table class="report-table"><thead><tr><th>Plage de jours</th><th>Courant attendu selon profils</th><th>CAN pondéré par le temps</th><th>Pic CAN / excès</th><th>Premier dépassement</th><th>Profils ECU appliqués</th></tr></thead>
            <tbody>${item.anomalies.map(row => `<tr class="fail"><td>Jour ${number(row.start_day)} à ${number(row.end_day)}<small class="coverage-note">${instant(row.started_at)} → ${instant(row.ended_at)}<br>${number(row.covered_s / 60)} min enregistrées · ${number(row.exceedances, 0)} mesures en dépassement</small></td>
                <td>${current(row.expected_A)}</td><td>${current(row.average_A)}</td><td>${current(row.peak_A)}<small class="coverage-note">Excès maximal : +${current(row.excess_peak_A)}</small></td><td>${instant(row.first_anomaly_at)}</td>
                <td><details><summary>${row.devices.length} ECU sélectionné(s)</summary>${row.devices.map(device => `<div>${html(device.name)} : profil ${device.profile}, ${current(device.expected_A)}</div>`).join('')}</details></td></tr>`).join('')}</tbody></table></div></article>`).join('')
            : '<p class="no-anomalies">Aucune surconsommation détectée dans les mesures disponibles. Les périodes sans données restent non vérifiées.</p>';
    };
})();
