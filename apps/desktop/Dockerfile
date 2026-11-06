# The members' computer (Yuki, open core): a Linux desktop with a browser, a terminal, a text
# editor and a file manager, the files helper, and a live view (VNC over a websocket, with the
# noVNC page) for the person. The desktop's apps are read and used through the accessibility bus
# (apps.py: their buttons and fields, numbered), with xdotool for keys.
# Runs as the non-root user `yuki` (uid 1000); /workspace is its home and persists in a volume.
# Started by docker-compose.yml next to the Yuki service, which drives it over the compose network
# (desktopd.py on :7070, the live view on :6080; neither is published on the host).
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git procps less nano python3 python3-websocket \
        xvfb x11-xserver-utils openbox tint2 xterm x11vnc novnc python3-websockify scrot \
        chromium fonts-dejavu-core fonts-wqy-microhei \
        dbus at-spi2-core libatk-adaptor python3-pyatspi gir1.2-atspi-2.0 xdotool mousepad thunar \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
    && useradd --uid 1000 --home-dir /workspace --no-create-home --shell /bin/bash yuki \
    && mkdir -p /workspace /secrets /opt/yuki-desktop \
    && chown 1000:1000 /workspace /secrets

COPY --chmod=0555 desktopd.py files.py apps.py browser /opt/yuki-desktop/
COPY --chmod=0444 xdg/ /opt/yuki-desktop/xdg/
RUN find /opt/yuki-desktop/xdg -type d -exec chmod 0555 {} +

ENV HOME=/workspace LANG=C.UTF-8 USER=yuki DESKTOP_TOKEN_FILE=/secrets/token
WORKDIR /workspace
USER 1000:1000
VOLUME ["/workspace"]
EXPOSE 7070 6080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7070/health || exit 1
ENTRYPOINT ["/usr/bin/python3", "-u", "/opt/yuki-desktop/desktopd.py"]
