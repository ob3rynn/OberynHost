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

The production wrapper image seeds this plugin into `/pelican-data/plugins/oberynhosttheme` on first boot. The plugin still needs to be installed through Pelican after the panel bootstrap is complete.
