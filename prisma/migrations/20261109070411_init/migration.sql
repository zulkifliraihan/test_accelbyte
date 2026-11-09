-- CreateTable
CREATE TABLE "matches" (
    "match_id" TEXT NOT NULL PRIMARY KEY,
    "duration_seconds" INTEGER NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "player_count" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "match_players" (
    "match_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "kills" INTEGER NOT NULL,
    "won" BOOLEAN NOT NULL,

    PRIMARY KEY ("match_id", "player_id"),
    CONSTRAINT "match_players_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches" ("match_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "player_stats" (
    "player_id" TEXT NOT NULL PRIMARY KEY,
    "total_kills" BIGINT NOT NULL DEFAULT 0,
    "total_wins" BIGINT NOT NULL DEFAULT 0,
    "total_playtime_seconds" BIGINT NOT NULL DEFAULT 0,
    "total_matches" BIGINT NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "idx_player_stats_kills" ON "player_stats"("total_kills" DESC, "player_id");

-- CreateIndex
CREATE INDEX "idx_player_stats_wins" ON "player_stats"("total_wins" DESC, "player_id");

-- CreateIndex
CREATE INDEX "idx_player_stats_playtime" ON "player_stats"("total_playtime_seconds" DESC, "player_id");
