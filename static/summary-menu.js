/* Native details keeps keyboard and screen-reader semantics on every page. */
(() => {
    const menus = Array.from(document.querySelectorAll('.app-summary details'));
    document.addEventListener('click', event => {
        menus.forEach(menu => {
            if (menu.open && !menu.contains(event.target)) menu.open = false;
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        menus.forEach(menu => {
            if (!menu.open) return;
            menu.open = false;
            menu.querySelector('summary')?.focus();
        });
    });
    menus.forEach(menu => menu.addEventListener('toggle', () => {
        if (menu.open) menus.forEach(other => {
            if (other !== menu) other.open = false;
        });
    }));
})();
