FROM golang:1.23-alpine AS build
WORKDIR /src
COPY . ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /usr/local/bin/prompterr ./cmd/server

FROM alpine:3.21
# Git's histogram diff is implemented in native C and runs outside the Go heap.
RUN apk add --no-cache git ca-certificates && addgroup -S prompterr && adduser -S -G prompterr prompterr
USER prompterr
WORKDIR /home/prompterr
COPY --from=build /usr/local/bin/prompterr /usr/local/bin/prompterr
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/prompterr"]
