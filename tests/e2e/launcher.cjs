// Point d'entrée Electron pour Playwright : profil utilisateur isolé, puis
// démarrage normal de l'application (desktop/main.js), sans aucune modification.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const profile = process.env.WATTMAN_E2E_PROFILE;
if (!profile) throw new Error('WATTMAN_E2E_PROFILE est requis.');
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'backend');

// Référentiel théorique de démonstration pour le dashboard de mesure, matériel absent.
const canData = path.join(profile, 'backend', 'can_data');
fs.mkdirSync(canData, { recursive: true });
fs.writeFileSync(path.join(canData, 'esp32_connection.json'), JSON.stringify({ base_url: 'http://127.0.0.1:9' }));
fs.writeFileSync(path.join(canData, 'theory_snapshot.json'), JSON.stringify({
  project: { id: 'e2e', name: 'Projet E2E' },
  devices: [
    { id: 'd1', name: 'ECU E2E A', kind: 'dcdc', nominal_A: 1 },
    { id: 'd2', name: 'ECU E2E B', kind: 'dcdc', nominal_A: 0.5 }
  ]
}));

require('../../desktop/main.js');
