FROM alpine:3.20
RUN apk add --no-cache openvpn dante-server
COPY start.sh route-up.sh sockd.conf /vpn/
RUN chmod +x /vpn/start.sh /vpn/route-up.sh
EXPOSE 1080
ENTRYPOINT ["/vpn/start.sh"]
