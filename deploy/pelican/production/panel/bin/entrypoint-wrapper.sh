#!/bin/ash
set -eu

PLUGIN_ID="oberynhosttheme"
PLUGIN_SOURCE="/opt/oberyn/pelican/plugins/${PLUGIN_ID}"
PLUGIN_TARGET="/pelican-data/plugins/${PLUGIN_ID}"
PLUGIN_HASH_FILE="/pelican-data/plugins/.${PLUGIN_ID}.source-sha256"

generate_app_key() {
    tr -dc 'A-Za-z0-9' </dev/urandom | fold -w 32 | head -n 1
}

plugin_source_hash() {
    find "${PLUGIN_SOURCE}" -type f | sort | while read -r path; do
        printf '%s\n' "$path"
        sha256sum "$path"
    done | sha256sum | awk '{print $1}'
}

sync_bundled_plugin() {
    if [ ! -d "${PLUGIN_SOURCE}" ]; then
        return 0
    fi

    source_hash="$(plugin_source_hash)"
    current_hash=""
    if [ -f "${PLUGIN_HASH_FILE}" ]; then
        current_hash="$(tr -d '\r\n' < "${PLUGIN_HASH_FILE}")"
    fi

    if [ ! -f "${PLUGIN_TARGET}/plugin.json" ] || [ "${source_hash}" != "${current_hash}" ]; then
        rm -rf "${PLUGIN_TARGET}"
        cp -R "${PLUGIN_SOURCE}" "${PLUGIN_TARGET}"
        printf '%s\n' "${source_hash}" > "${PLUGIN_HASH_FILE}"
    fi
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
    # The upstream image normally creates /pelican-data/.env itself. We
    # pre-create it here because this wrapper intentionally uses host bind
    # mounts and needs the runtime file to become writable by www-data before
    # the web installer touches it.
    APP_KEY_VALUE="${APP_KEY:-}"
    if [ -z "${APP_KEY_VALUE}" ]; then
        APP_KEY_VALUE="$(generate_app_key)"
    fi

    {
        printf 'APP_KEY=%s\n' "${APP_KEY_VALUE}"
        printf 'APP_INSTALLED=false\n'
    } >/pelican-data/.env
fi

if ! grep -q '^APP_INSTALLED=' /pelican-data/.env 2>/dev/null; then
    printf '\nAPP_INSTALLED=false\n' >> /pelican-data/.env
fi

sync_bundled_plugin

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
