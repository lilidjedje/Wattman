let monChart = null; 

// Enregistrement obligatoire du plugin de zoom
Chart.register(ChartZoom); 

// Fonction de formatage unifiée pour l'oscilloscope et le rapport global (Sans millisecondes)
function formatTimestamp(unixTimestamp) {
    if (!unixTimestamp) return "Inconnue"; 
    
    const date = new Date(unixTimestamp * 1000); 
    
    const jour = String(date.getDate()).padStart(2, '0'); 
    const mois = String(date.getMonth() + 1).padStart(2, '0'); 
    const annee = date.getFullYear(); 
    const heures = String(date.getHours()).padStart(2, '0'); 
    const minutes = String(date.getMinutes()).padStart(2, '0'); 
    const secondes = String(date.getSeconds()).padStart(2, '0'); 
    
    return `${jour}/${mois}/${annee} ${heures}:${minutes}:${secondes}`;
}

function addTimeParams(params, start, end) {
    if (start) {
        const startTs = Date.parse(start);
        if (!Number.isNaN(startTs)) {
            params.set("start_ts", String(startTs / 1000));
        } else {
            params.set("start", start);
        }
    }
    if (end) {
        const endTs = Date.parse(end);
        if (!Number.isNaN(endTs)) {
            params.set("end_ts", String(endTs / 1000));
        } else {
            params.set("end", end);
        }
    }
}

function appliquerFiltres() {
    const seuilInput = document.getElementById("seuilCourant").value; 
    const start = document.getElementById("dateDebut").value; 
    const end = document.getElementById("dateFin").value; 
    const unite = document.getElementById("uniteCourant").value; 

    let seuilAmpere = parseFloat(seuilInput) || 0.0;
    if (unite === "mA") {
        seuilAmpere = seuilAmpere / 1000.0; 
    }

    const channel = document.getElementById("canalSelect").value;
    const params = new URLSearchParams({ seuil: seuilAmpere });
    addTimeParams(params, start, end);
    if (channel) params.set("channel", channel);

    fetch(`api/detect_peaks?${params.toString()}`)
        .then(response => {
            if (!response.ok) throw new Error("Erreur serveur");
            return response.json();
        })
        .then(data => {
            // Appel direct du tracé graphique sans diagnostic intermédiaire
            mettreAJourGraphique(data, unite); 
            genererRapportPics(seuilAmpere, unite);
        })
        .catch(err => console.error("Erreur filtres:", err));
}

function genererRapportPics(seuilAmpere = null, unite = null) {
    if (seuilAmpere === null) {
        const seuilInput = document.getElementById("seuilCourant").value;
        unite = document.getElementById("uniteCourant").value;
        seuilAmpere = parseFloat(seuilInput) || 0.0;
        if (unite === "mA") {
            seuilAmpere = seuilAmpere / 1000.0;
        }
    }

    const reportBody = document.getElementById("picsReportTableBody");
    reportBody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 15px;">Scan en cours...</td></tr>`;

    const start = document.getElementById("dateDebut").value;
    const end = document.getElementById("dateFin").value;
    const channel = document.getElementById("canalSelect").value;
    const params = new URLSearchParams({ seuil: seuilAmpere });
    addTimeParams(params, start, end);
    if (channel) params.set("channel", channel);

    fetch(`api/global_peaks_report?${params.toString()}`)
        .then(r => r.json())
        .then(data => {
            if (data.length === 0) {
                reportBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: green; padding: 15px;">Aucun pic.</td></tr>`;
                return;
            }
            
            let html = "";
            const coeff = (unite === "mA") ? 1000.0 : 1.0;

            data.forEach(p => {
                const badgeColor = p.capteur === "A" ? "#2563eb" : "#dc2626";
                const valeurConvertie = p.valeur_max * coeff;

                html += `<tr>
                    <td style="font-weight: bold; color: ${badgeColor};">${p.capteur}</td>
                    <td>${formatTimestamp(p.debut)}</td>
                    <td style="font-weight: bold;">${valeurConvertie.toFixed(unite === "mA" ? 2 : 6)} ${unite}</td>
                    <td>${p.duree_ms.toFixed(2)} ms</td>
                </tr>`;
            });
            reportBody.innerHTML = html;
        });
}

// ====== LOGIQUE DU GRAPHE D'ORIGINE RESTAURÉE ======
function mettreAJourGraphique(data, unite = "A") {
    const ctx = document.getElementById('monGraphique').getContext('2d');

    if (monChart) {
        monChart.destroy();
    }

    const coeff = (unite === "mA") ? 1000.0 : 1.0;
    const datasets = [];

    if (data.points_A) {
        datasets.push({
            label: `Canal A (${unite})`,
            data: data.points_A.map(p => ({ x: p.timestamp, y: p.current * coeff })),
            borderColor: 'rgb(255, 99, 132)',
            showLine: true,
            pointRadius: 0
        });
    }
    if (data.points_B) {
        datasets.push({
            label: `Canal B (${unite})`,
            data: data.points_B.map(p => ({ x: p.timestamp, y: p.current * coeff })),
            borderColor: 'rgb(54, 162, 235)',
            showLine: true,
            pointRadius: 0
        });
    }

    monChart = new Chart(ctx, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            scales: {
                x: { type: 'linear', position: 'bottom' }
            },
            plugins: {
                zoom: {
                    zoom: {
                        wheel: { enabled: true, modifierKey: 'ctrl' },
                        pinch: { enabled: true },
                        mode: 'x'
                    },
                    pan: {
                        enabled: true,
                        mode: 'x'
                    }
                }
            }
        }
    });
}

function getSelectedChannel() {
    const channel = document.getElementById("canalSelect").value;
    return channel && (channel === "A" || channel === "B") ? channel : null;
}

function telechargerCSVCompletes() {
    const start = document.getElementById("dateDebut").value;
    const end = document.getElementById("dateFin").value;
    const channel = getSelectedChannel();
    const unit = document.getElementById("uniteCourant").value;
    const params = new URLSearchParams();
    addTimeParams(params, start, end);
    if (channel) params.set("channel", channel);
    if (unit) params.set("unit", unit);
    window.location.href = `api/export_measurements_csv?${params.toString()}`;
}

function chargerResume1m() {
    const start = document.getElementById("dateDebut").value;
    const end = document.getElementById("dateFin").value;
    const channel = getSelectedChannel();

    const reportBody = document.getElementById("resume1mTableBody");
    reportBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 15px;">Chargement du résumé 1 min...</td></tr>`;

    const params = new URLSearchParams();
    addTimeParams(params, start, end);
    if (channel) params.set("channel", channel);

    fetch(`api/measurements_summary_1m?${params.toString()}`)
        .then(r => r.json())
        .then(data => {
            if (!data.summary || data.summary.length === 0) {
                reportBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: green; padding: 15px;">Aucune donnée de résumé trouvée.</td></tr>`;
                return;
            }

            reportBody.innerHTML = data.summary.map(item => `
                <tr>
                    <td>${formatTimestamp(item.timestamp_minute)}</td>
                    <td>${item.channel}</td>
                    <td>${item.current_min.toFixed(6)}</td>
                    <td>${item.current_max.toFixed(6)}</td>
                    <td>${item.current_avg.toFixed(6)}</td>
                </tr>
            `).join("");
        })
        .catch(err => {
            console.error(err);
            reportBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red; padding: 15px;">Erreur lors du chargement du résumé.</td></tr>`;
        });
}

function purgerBaseDeDonnees() {
    if (confirm("Purger la base ?")) {
        fetch('api/purge_database', { method: 'POST' }).then(r => r.json()).then(data => {
            alert(data.message); 
            if (monChart) monChart.destroy();
            document.getElementById("picsReportTableBody").innerHTML = `<tr><td colspan="4" style="text-align: center;">Vide.</td></tr>`;
            document.getElementById("resume1mTableBody").innerHTML = `<tr><td colspan="5" style="text-align: center;">Vide.</td></tr>`;
        });
    }
}

function uploaderEtIngererLogs() {
    const fileInput = document.getElementById("fileInputASC");
    if (fileInput.files.length === 0) return;
    const formData = new FormData();
    for (let i = 0; i < fileInput.files.length; i++) { formData.append("files", fileInput.files[i]); }
    fetch('api/upload_and_ingest_measures', { method: 'POST', body: formData })
    .then(r => r.json()).then(() => { alert("Import terminé."); fileInput.value = ""; appliquerFiltres(); });
}
