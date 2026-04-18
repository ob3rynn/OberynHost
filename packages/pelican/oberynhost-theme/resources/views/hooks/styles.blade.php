<style>
    :root {
        --oberyn-bg: #0d0f10;
        --oberyn-bg-soft: #131617;
        --oberyn-panel: #151819;
        --oberyn-panel-soft: #1a1f20;
        --oberyn-line: rgba(230, 220, 209, 0.08);
        --oberyn-text: #f2ece3;
        --oberyn-muted: #c5bbb0;
        --oberyn-accent: #1b555b;
        --oberyn-accent-soft: rgba(20, 72, 77, 0.22);
        --oberyn-accent-strong: #2a8b8f;
        --oberyn-accent-glow: #99eef3;
        --oberyn-shadow: 0 22px 54px rgba(0, 0, 0, 0.34);
        --font-family: "Avenir Next", "Segoe UI Variable", "Segoe UI", sans-serif;
        --serif-font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
        --primary-500: #2a8b8f;
        --primary-600: #1f6d71;
    }

    .fi-body {
        color: var(--oberyn-text);
        background:
            radial-gradient(circle at top center, rgba(20, 72, 77, 0.28), transparent 26%),
            radial-gradient(circle at 50% -10%, rgba(126, 208, 203, 0.08), transparent 18%),
            linear-gradient(180deg, #101314, #090a0b);
    }

    .fi-logo,
    .fi-simple-header-heading,
    .fi-page-header-heading,
    .fi-section-header-heading,
    .fi-ta-header-cell-label {
        font-family: var(--serif-font-family);
    }

    .fi-logo,
    .fi-simple-header-heading,
    .fi-page-header-heading,
    .fi-section-header-heading,
    .fi-body,
    .fi-fo-field-label,
    .fi-topbar-item-label,
    .fi-sidebar-item-label {
        color: var(--oberyn-text);
    }

    .fi-simple-main,
    .fi-topbar,
    .fi-sidebar,
    .fi-modal-window,
    .fi-dropdown-panel,
    .fi-ta-table-container,
    .fi-section,
    .fi-fo-field,
    .fi-input-wrp {
        border-color: var(--oberyn-line);
        box-shadow: var(--oberyn-shadow);
    }

    .fi-simple-main,
    .fi-modal-window,
    .fi-dropdown-panel,
    .fi-ta-table-container,
    .fi-section {
        background:
            linear-gradient(180deg, rgba(42, 139, 143, 0.09), rgba(255, 255, 255, 0.015)),
            rgba(17, 20, 21, 0.96);
        border-radius: 28px;
    }

    .fi-topbar,
    .fi-sidebar {
        background: rgba(18, 21, 22, 0.92);
        backdrop-filter: blur(16px);
    }

    .fi-sidebar,
    .fi-topbar {
        color: var(--oberyn-text);
    }

    .fi-input-wrp,
    .fi-input-wrp-content-ctn,
    .fi-input {
        background: rgba(255, 255, 255, 0.03);
        color: var(--oberyn-text);
    }

    .fi-fo-field-label,
    .fi-ta-header-cell-label,
    .fi-pagination-records-label,
    .fi-pagination-overview {
        color: var(--oberyn-muted);
    }

    .fi-btn-color-primary,
    .fi-color-primary .fi-btn {
        background: linear-gradient(145deg, var(--oberyn-accent-glow), var(--oberyn-accent-strong) 38%, var(--oberyn-accent) 78%);
        color: #071b1c;
        border-color: transparent;
        box-shadow:
            inset 0 1px 1px rgba(255, 255, 255, 0.18),
            0 10px 24px rgba(20, 72, 77, 0.28);
    }

    .fi-link,
    .fi-link:hover,
    .fi-ac,
    .fi-badge {
        color: var(--oberyn-text);
    }

    .fi-badge {
        border-radius: 999px;
    }

    .oberyn-auth-brand {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 1.5rem;
        padding: 16px 18px;
        border: 1px solid var(--oberyn-line);
        border-radius: 22px;
        background: rgba(18, 21, 22, 0.92);
        box-shadow: var(--oberyn-shadow);
    }

    .oberyn-brand-mark,
    .oberyn-logo-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 14px;
        background: linear-gradient(145deg, var(--oberyn-accent-glow), var(--oberyn-accent-strong) 38%, var(--oberyn-accent) 78%);
        color: #071b1c;
        font-family: var(--font-family);
        font-weight: 800;
        letter-spacing: 0.05em;
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.18);
    }

    .oberyn-auth-brand-copy {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .oberyn-auth-brand-copy strong {
        color: var(--oberyn-text);
        font-family: var(--serif-font-family);
        font-size: 1.1rem;
        line-height: 1.1;
    }

    .oberyn-auth-brand-copy span,
    .oberyn-logo-mark + * {
        color: var(--oberyn-muted);
        font-size: 0.94rem;
    }

    .oberyn-logo-mark {
        margin-inline-start: 0.75rem;
        width: 2rem;
        height: 2rem;
        border-radius: 12px;
        font-size: 0.8rem;
    }
</style>
