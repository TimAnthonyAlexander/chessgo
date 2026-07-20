# Puzzle solve-rate benchmark

Measures engine strength on real Lichess positions (the 200K-puzzle `puzzle` table)
by solve rate — far better signal than 0.1s self-play for search/eval changes, since
it uses real positions with ground-truth best moves.

## Export puzzles
```
mysql -h127.0.0.1 -P3306 --protocol=TCP -uchessgo -p"$DB_PASSWORD" chessgo --batch --raw \
  -e "SELECT fen, moves, rating FROM puzzle;" > puzzles.tsv
```

## Run
```
python3 tools/puzzlebench.py ./zugzwang puzzles.tsv <movetime_ms> <max_pieces|0=any> <sample> [ENV=VAL ...]
```
- `max_pieces=5` restricts to Syzygy 5-man range; `0` = any.
- Lichess convention: fen is BEFORE the opponent setup move; moves[0] is auto-played,
  moves[1] is the first solution the engine must find. OwnBook is disabled (measures search).

## Findings (2026-07-20)
- **Syzygy on <=5-man puzzles: 100% correct both on/off, but 4s vs 221s (~55x faster).**
  Search already plays simple endgames perfectly, so TB adds speed (clock savings /
  instant website endgames), not puzzle-rate — which is why the movetime SPRT is flat.
- Use a broad random sample (max_pieces=0) at a short movetime to discriminate engine
  versions on middlegame tactics (net retrains, search changes).
