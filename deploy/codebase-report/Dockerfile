# The codebase report's measurement engine: pinned scc, jscpd, lizard and git
# beside Node, reading a checkout mounted read-only at /repo. Every download is
# checked against the digest its publisher lists (GitHub release checksums,
# the npm registry, PyPI). The image runs no package manager on the measured
# project and starts none of its code.
# Official Node image index, including Linux amd64 and arm64.
FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
ARG TARGETARCH
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) asset=x86_64 digest=3d9d65b00ca874c2b29151abe7e1480736f5229edc3ce8e4b2791460cdfabf5a ;; \
      arm64) asset=arm64 digest=dcb05c6e993bb2d8d2da4765ff018f2e752325dd205a41698929c55e4123575d ;; \
      *) exit 1 ;; \
    esac && curl --fail --location --silent --show-error "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Linux_${asset}.tar.gz" -o /tmp/scc.tar.gz \
    && echo "$digest  /tmp/scc.tar.gz" | sha256sum --check - \
    && mkdir -p /tmp/scc /usr/local/share/licenses/scc && tar -xzf /tmp/scc.tar.gz -C /tmp/scc scc LICENSE \
    && install /tmp/scc/scc /usr/local/bin/scc && cp /tmp/scc/LICENSE /usr/local/share/licenses/scc/LICENSE \
    && rm -rf /tmp/scc /tmp/scc.tar.gz && scc --version
# jscpd 5 is a self-contained binary published in a per-platform npm package.
RUN case "$TARGETARCH" in \
      amd64) package=jscpd-linux-x64-gnu digest=4c7c9ed9afa5dc02a929fd57958098eaef42081a52e2bd3f88cb490e350f9222 ;; \
      arm64) package=jscpd-linux-arm64-gnu digest=dc9f8ede2c816a9bbcf6fa92a246ad7431d0b4ec1941a2487c0cc6b427a0c423 ;; \
      *) exit 1 ;; \
    esac && curl --fail --location --silent --show-error "https://registry.npmjs.org/${package}/-/${package}-5.4.0.tgz" -o /tmp/jscpd.tgz \
    && echo "$digest  /tmp/jscpd.tgz" | sha256sum --check - \
    && mkdir -p /tmp/jscpd /usr/local/share/licenses/jscpd && tar -xzf /tmp/jscpd.tgz -C /tmp/jscpd package/bin/jscpd package/LICENSE \
    && install /tmp/jscpd/package/bin/jscpd /usr/local/bin/jscpd && cp /tmp/jscpd/package/LICENSE /usr/local/share/licenses/jscpd/LICENSE \
    && rm -rf /tmp/jscpd /tmp/jscpd.tgz && jscpd --version
# lizard and its two dependencies are pure-Python wheels, unpacked into one
# folder that measure.mjs puts on Python's path; each keeps its license in its dist-info.
RUN mkdir -p /opt/lizard /tmp/wheels && cd /tmp/wheels \
    && printf '%s\n' \
      'https://files.pythonhosted.org/packages/60/c1/1da7937391a7e67edfb33bb3cd6d3426a7027cf3dd904ecb29c2b4416e78/lizard-1.24.0-py2.py3-none-any.whl a688bc607a891ff4a7836826f25742dc9c1bf648da3075dbd495e199e8848602' \
      'https://files.pythonhosted.org/packages/71/46/17f022dd3e953bf20a04a028a21ec746d942f8d2af30fa0f124fa0e6a684/pygments-2.21.0-py3-none-any.whl 2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9' \
      'https://files.pythonhosted.org/packages/f1/d9/7fb5aa316bc299258e68c73ba3bddbc499654a07f151cba08f6153988714/pathspec-1.1.1-py3-none-any.whl a00ce642f577bf7f473932318056212bc4f8bfdf53128c78bbd5af0b9b20b189' \
    | while read -r url digest; do \
        file="${url##*/}"; \
        curl --fail --location --silent --show-error "$url" -o "$file" \
        && echo "$digest  $file" | sha256sum --check - \
        && python3 -I -m zipfile -e "$file" /opt/lizard || exit 1; \
      done \
    && cd / && rm -rf /tmp/wheels \
    && python3 -I -c 'import sys; sys.path.insert(0, "/opt/lizard"); import lizard; sys.argv = ["lizard", "--version"]; sys.exit(lizard.main())'
COPY measure.mjs /opt/measure/measure.mjs
ENV NOTICEOS_LIZARD_HOME=/opt/lizard
USER node
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/measure/measure.mjs"]
CMD ["--help"]
