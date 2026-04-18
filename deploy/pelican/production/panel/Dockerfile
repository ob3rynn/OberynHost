# syntax=docker/dockerfile:1.7

ARG PELICAN_BASE_IMAGE=ghcr.io/pelican-dev/panel:v1.0.0-beta33
FROM ${PELICAN_BASE_IMAGE}

LABEL org.opencontainers.image.title="OberynHost Pelican Panel"
LABEL org.opencontainers.image.description="Thin OberynHost wrapper over the pinned upstream Pelican panel image."

COPY packages/pelican/oberynhost-theme /opt/oberyn/pelican/plugins/oberynhosttheme
COPY --chmod=0755 deploy/pelican/production/panel/bin/entrypoint-wrapper.sh /usr/local/bin/oberyn-panel-entrypoint

ENTRYPOINT ["/usr/local/bin/oberyn-panel-entrypoint"]
CMD ["supervisord", "-n", "-c", "/etc/supervisord.conf"]
