#!/bin/ash
set -eu

PLUGIN_ID="oberynhosttheme"
PLUGIN_SOURCE="/opt/oberyn/pelican/plugins/${PLUGIN_ID}"
PLUGIN_TARGET="/pelican-data/plugins/${PLUGIN_ID}"

generate_app_key() {
    tr -dc 'A-Za-z0-9' </dev/urandom | fold -w 32 | head -n 1
}

mkdir -p \
    /pelican-data/database \
    /pelican-data/plugins \
    /pelican-data/storage/avatars \
    /pelican-data/storage/fonts \
    /pelican-data/storage/icons \
    /var/www/html/storage/logs \
    /var/www/html/storage/logs/supervisord

if [ ! -f /pelican-data/.env ]; then
    APP_KEY_VALUE="${APP_KEY:-}"
    if [ -z "${APP_KEY_VALUE}" ]; then
        APP_KEY_VALUE="$(generate_app_key)"
    fi

    {
        printf 'APP_KEY=%s\n' "${APP_KEY_VALUE}"
        printf 'APP_INSTALLED=false\n'
    } >/pelican-data/.env
fi

if [ -d "${PLUGIN_SOURCE}" ] && [ ! -f "${PLUGIN_TARGET}/plugin.json" ]; then
    cp -R "${PLUGIN_SOURCE}" "${PLUGIN_TARGET}"
fi

chown www-data:www-data /pelican-data/.env
chmod 0640 /pelican-data/.env

chown -R www-data:www-data \
    /pelican-data/database \
    /pelican-data/plugins \
    /pelican-data/storage \
    /var/www/html/bootstrap/cache \
    /var/www/html/storage/logs
chmod -R u+rwX,g+rwX \
    /pelican-data/database \
    /pelican-data/plugins \
    /pelican-data/storage \
    /var/www/html/bootstrap/cache \
    /var/www/html/storage/logs

exec /bin/ash /entrypoint.sh "$@"
