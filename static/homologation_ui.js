(function () {
    const RESET_KEYS = [
        'profileMatrix',
        'alternatorMatrix',
        'modifiedCurrents',
        'modifiedLowers',
        'modifiedUppers',
        'homologationConfiguration'
    ];

    function navigateHome() {
        const activeProject = window.ProjectStorage && ProjectStorage.getActiveProject();
        if (activeProject && activeProject.name) {
            window.location.href = '/';
            return;
        }
        alert("Veuillez d'abord enregistrer le projet pour pouvoir revenir à la page d'accueil.");
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (window.ProjectStorage) {
            ProjectStorage.bindSaveButton('project-save', 'saved-status');
        }

        const resetButton = document.getElementById('reset-btn');
        if (resetButton) {
            resetButton.addEventListener('click', function () {
                if (!confirm('Restaurer les valeurs initiales des quatre étapes Homologation ? Les équipements ajoutés ou supprimés seront conservés.')) return;
                const keys = document.body.classList.contains('homologation-config-page')
                    ? ['homologationConfiguration']
                    : RESET_KEYS;
                keys.forEach((key) => sessionStorage.removeItem(key));
                window.location.reload();
            });
        }

        const homeButton = document.getElementById('homologation-home');
        if (homeButton) homeButton.addEventListener('click', navigateHome);

        document.addEventListener('click', function (event) {
            const details = document.getElementById('actions-details');
            if (details && !details.contains(event.target)) details.removeAttribute('open');
        });
    });
}());
