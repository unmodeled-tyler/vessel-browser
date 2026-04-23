# Pull the pre-built image from GitHub Container Registry.
# This avoids OOM issues on HF Spaces free tier (cpu-basic).
FROM ghcr.io/unmodeled-tyler/vessel-browser-demo:latest

# Allow overriding the entrypoint from the Space repo without rebuilding the full image.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
CMD ["/entrypoint.sh"]
