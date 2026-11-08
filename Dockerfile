FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install

WORKDIR /app

# کش شدن نصب وابستگی‌ها
COPY package.json bun.lock ./
RUN bun install

# کد برنامه
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/db \
    DATABASE_URL=file:/app/db/custom.db

RUN mkdir -p /app/db && bunx prisma generate && bun run build

COPY entrypoint.sh backup.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "start"]
