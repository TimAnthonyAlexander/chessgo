# zugzwang tools

## `sfnet_parse.py` — Stockfish `.nnue` reference parser

Stdlib-only parser/validator for SF18 evaluation files. Recomputes the feature-transformer,
layer-stack and top-level hashes from SF's own rules (nothing is read from the file and
compared to itself), then walks every array and asserts zero remainder.

```
python3 tools/sfnet_parse.py ~/sf18-arm/src/nn-c288c895ea92.nnue           # big threats net
python3 tools/sfnet_parse.py ~/sf18-arm/src/nn-37f18f62d772.nnue --small   # 128-wide small net
python3 tools/sfnet_parse.py <net> --full                                  # also decode the 23M weights (~5s)
```

It is the oracle for the SF-backend loader in `../docs/tasks/open/sf-net-experiment.md`.
No Stockfish code is used or vendored — only the format is reproduced.

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
