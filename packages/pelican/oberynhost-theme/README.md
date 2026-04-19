# OberynHost Theme Plugin

This package is a small Pelican branding plugin meant for the production wrapper image.

## Scope

- match the storefront’s dark slate + teal palette
- switch the shell typography toward the existing OberynHost serif/body pairing
- brand the auth flow and panel shell lightly
- avoid deep Pelican core patches or a full custom Filament theme build

## Runtime

- plugin id: `oberynhosttheme`
- install command: `php artisan p:plugin:install oberynhosttheme`
- category: `plugin`
- compatibility: `panel_version` is pinned to `^1.0.0-beta33`

The production wrapper image syncs this plugin into `/pelican-data/plugins/oberynhosttheme` on boot whenever the bundled plugin source changes. The local panel path does the same sync during `panel-init`.

The plugin still needs to be installed through Pelican after the panel bootstrap is complete. That install/enabled state is intentionally kept separate from file seeding because Pelican's plugin lifecycle is database-backed.

## Update Expectations

- Local stack: after changing this package, rerun `docker compose up -d --force-recreate panel-init panel` from `apps/pelicanpanel`
- Production stack: rebuild the wrapper image, restart the panel stack, then confirm the plugin still shows as enabled
- Panel version bumps: after changing the panel image pin, verify `php artisan p:plugin:list`, the login page, the panel shell, and that the render-hook constants used in `src/OberynHostThemePlugin.php` still exist before committing the new version
