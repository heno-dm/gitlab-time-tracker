FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gettext \
        gnome-shell \
        libglib2.0-bin \
        make \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
