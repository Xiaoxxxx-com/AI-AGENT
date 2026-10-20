#!/usr/bin/env bash
# 每日备份：保留 14 天。用法：BACKUP_DIR=/backup ./ops/backup.sh
set -euo pipefail

CONTAINER="${CONTAINER:-companion-db}"
DB_USER="${DB_USER:-companion}"
DB_NAME="${DB_NAME:-companion}"
BACKUP_DIR="${BACKUP_DIR:-./var/backup}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/companion-$(date +%F).dump"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$FILE"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'companion-*.dump' -mtime "+$KEEP_DAYS" -delete
echo "pruned backups older than ${KEEP_DAYS} days"

# 恢复演练（每季度一次）：
#   docker exec -i companion-db pg_restore -U companion -d companion_test --clean --if-exists < backup.dump
# 恢复后确认索引：
#   docker exec -it companion-db psql -U companion -d companion -c "\di idx_notes_embedding"
