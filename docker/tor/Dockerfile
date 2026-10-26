FROM alpine:3.20
RUN apk add --no-cache tor
COPY start.sh /tor/
RUN chmod +x /tor/start.sh
USER tor
EXPOSE 1080
ENTRYPOINT ["/tor/start.sh"]
