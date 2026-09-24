# syntax=docker/dockerfile:1.7
# Official RELEASE.2025-04-22T22-12-26Z source. The old public image and
# binary archive are unavailable; retain the release without registry secrets.
FROM golang:1.24.2-alpine AS build
ADD --checksum=sha256:7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5 https://codeload.github.com/minio/minio/tar.gz/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e /tmp/minio.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 && rm /tmp/minio.tar.gz
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -tags kqueue -ldflags '-s -w -X github.com/minio/minio/cmd.Version=2025-04-22T22:12:26Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-04-22T22-12-26Z -X github.com/minio/minio/cmd.CommitID=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e -X github.com/minio/minio/cmd.ShortCommitID=0d7408fc9969' -o /out/minio .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates curl
COPY --from=build /out/minio /usr/bin/minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="0d7408fc9969caf07de6a8c3a84f9fbb10a6739e"
ENTRYPOINT ["/usr/bin/minio"]
