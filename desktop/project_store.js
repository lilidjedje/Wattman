const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function createProjectStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = id => path.join(directory, `${createHash('sha256').update(String(id)).digest('hex')}.json`);
  function read(id) {
    for (const suffix of ['', '.bak']) {
      try {
        const record = JSON.parse(fs.readFileSync(filename(id) + suffix, 'utf8'));
        if (record.metadata?.id === id && record.snapshot?.sessionStorage) return record;
      } catch {}
    }
    return null;
  }
  return {
    read,
    list() {
      const ids = new Set();
      const records = [];
      for (const entry of fs.readdirSync(directory).filter(name => /\.json(?:\.bak)?$/.test(name))) {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8'));
          const id = record.metadata?.id;
          if (id && !ids.has(id)) {
            const valid = read(id);
            if (valid) { records.push(valid.metadata); ids.add(id); }
          }
        } catch {}
      }
      return records;
    },
    write(record) {
      if (!record?.metadata?.id || !record.snapshot?.sessionStorage) throw new Error('Projet invalide.');
      const target = filename(record.metadata.id);
      const previous = read(record.metadata.id);
      if (previous?.snapshot.sessionStorage.excelData && !record.snapshot.sessionStorage.excelData) {
        throw new Error('Sauvegarde vide refusée : la fiche Excel du projet est absente.');
      }
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(record), 'utf8');
      if (previous) fs.writeFileSync(`${target}.bak`, JSON.stringify(previous), 'utf8');
      fs.renameSync(temporary, target);
      return true;
    },
    delete(id) {
      for (const suffix of ['', '.bak', '.tmp']) fs.rmSync(filename(id) + suffix, { force: true });
    }
  };
}

module.exports = { createProjectStore };
