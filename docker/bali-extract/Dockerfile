FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates bzip2 python3 \
 && rm -rf /var/lib/apt/lists/*
COPY extract.sh /usr/local/bin/extract.sh
RUN chmod +x /usr/local/bin/extract.sh
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/extract.sh"]
