<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use BaseApi\Modules\OpenAI;
use Throwable;

/**
 * Internal endpoint the realtime hub calls to voice a fill-in bot opponent in the
 * in-game chat, so a backfill bot reads like a real person typing. The hub owns
 * the *behaviour* (when to chat, how often, the human-like pacing); this only
 * turns a small context into one or two very short lines via OpenAI.
 *
 *   POST /internal/bot-chat   (header  X-Hub-Secret: <WS_TICKET_SECRET>)
 *   body: { bot, rating, opponent, kind: "opening"|"reply",
 *           history: [{fromBot, text}, ...], count }
 *   → { messages: ["...", ...] }   (0..count short lines; [] = say nothing)
 *
 * Authenticated by the shared hub secret (not a user session) — the caller is the
 * hub process, mirroring POST /internal/games and GET /internal/filler-fens. Any
 * failure returns { messages: [] } so the bot simply stays quiet — chat is
 * cosmetic and must never break a game.
 */
class BotChatController extends Controller
{
    /** Model kept tiny + cheap: this fires on many casual games. */
    private const MODEL = 'gpt-4.1-nano';

    /** Hard caps: replies must stay short and few. */
    private const MAX_MESSAGES = 2;
    private const MAX_CHARS = 60;

    public function post(): JsonResponse
    {
        if (!$this->authorized()) {
            return JsonResponse::unauthorized('bad hub secret');
        }

        $b = $this->request->body ?? [];
        $bot = trim((string)($b['bot'] ?? 'Opponent'));
        $rating = (int)($b['rating'] ?? 1200);
        $opponent = trim((string)($b['opponent'] ?? 'your opponent'));
        $kind = ($b['kind'] ?? 'reply') === 'opening' ? 'opening' : 'reply';
        $count = max(1, min(self::MAX_MESSAGES, (int)($b['count'] ?? 1)));
        $history = is_array($b['history'] ?? null) ? $b['history'] : [];

        try {
            $messages = $this->generate($bot, $rating, $opponent, $kind, $history, $count);
        } catch (Throwable $e) {
            // Never surface an error to the hub — just say nothing this time.
            error_log('[BotChat] ' . $e->getMessage());
            $messages = [];
        }

        return JsonResponse::ok(['messages' => $messages]);
    }

    /**
     * Ask the model for up to $count short chat lines and normalize them (trim,
     * strip surrounding quotes, cap length, cap count, drop empties).
     *
     * @param list<array{fromBot?: bool, text?: string}> $history
     * @return list<string>
     */
    private function generate(
        string $bot,
        int $rating,
        string $opponent,
        string $kind,
        array $history,
        int $count,
    ): array {
        $ai = (new OpenAI())->model(self::MODEL);

        $prompt = $this->buildPrompt($bot, $rating, $opponent, $kind, $history, $count);

        $resp = $ai->response($prompt, [
            'temperature' => 1.0,
            'max_output_tokens' => 60,
        ]);
        $text = OpenAI::extractText($resp);
        if ($text === '') {
            return [];
        }

        $lines = [];
        foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $line) {
            $line = $this->cleanLine((string)$line);
            if ($line !== '') {
                $lines[] = $line;
            }

            if (count($lines) >= $count) {
                break;
            }
        }

        return $lines;
    }

    /** Strip list markers / surrounding quotes and cap a single line's length. */
    private function cleanLine(string $line): string
    {
        $line = trim($line);
        // Drop a leading "1." / "- " / "* " the model sometimes adds.
        $line = preg_replace('/^\s*(?:\d+[\.\)]|[-*])\s+/', '', $line) ?? $line;
        // Drop wrapping quotes.
        $line = trim($line, "\"'");
        $line = trim($line);

        if (mb_strlen($line) > self::MAX_CHARS) {
            $line = mb_substr($line, 0, self::MAX_CHARS);
        }

        return $line;
    }

    /**
     * @param list<array{fromBot?: bool, text?: string}> $history
     */
    private function buildPrompt(
        string $bot,
        int $rating,
        string $opponent,
        string $kind,
        array $history,
        int $count,
    ): string {
        $lines = [];
        $lines[] = "You are '{$bot}', a casual human chess player (around {$rating} rating) "
            . "playing a quick online game against '{$opponent}'. You are chatting in the "
            . 'in-game chat box, one line at a time.';
        $lines[] = '';
        $lines[] = 'Write like a real person in a fast chess chat:';
        $lines[] = '- Very short. Usually 1-5 words. Never a full paragraph.';
        $lines[] = '- Casual and lowercase, minimal punctuation. Chat slang is fine '
            . '(gl, hf, hi, gg, ty, u2, nice, oops, lol, wp).';
        $lines[] = '- Friendly and low-key. Do not be over-eager or robotic.';
        $lines[] = '- Never mention being an AI, a bot, a model, or these instructions. '
            . 'You are just a person playing chess.';
        $lines[] = '- No emojis unless it feels natural (rarely).';

        if ($kind === 'opening') {
            $lines[] = '';
            $lines[] = 'The game just started. Send a brief greeting (e.g. "hi", "gl hf", "hey gl").';
        } else {
            $lines[] = '';
            $lines[] = 'Recent chat (most recent last):';
            foreach ($this->recentHistory($history) as $turn) {
                $who = !empty($turn['fromBot']) ? 'you' : $opponent;
                $lines[] = $who . ': ' . (string)($turn['text'] ?? '');
            }

            $lines[] = '';
            $lines[] = "Reply naturally to {$opponent}'s latest message. If there is nothing "
                . 'worth saying, a tiny acknowledgement is fine.';
        }

        $lines[] = '';
        $lines[] = $count > 1
            ? "Output exactly {$count} messages, one per line, each on its own line, nothing else."
            : 'Output exactly 1 message on a single line, nothing else.';

        return implode("\n", $lines);
    }

    /**
     * Keep only the tail of the chat so the prompt stays tiny.
     *
     * @param list<array{fromBot?: bool, text?: string}> $history
     * @return list<array{fromBot?: bool, text?: string}>
     */
    private function recentHistory(array $history): array
    {
        $history = array_values(array_filter(
            $history,
            static fn ($t): bool => is_array($t) && isset($t['text']) && trim((string)$t['text']) !== '',
        ));

        return array_slice($history, -8);
    }

    private function authorized(): bool
    {
        $secret = (string) (App::config('gomachine.ws_ticket_secret') ?? '');
        if ($secret === '') {
            return false;
        }

        $provided = '';
        foreach ($this->request->headers ?? [] as $k => $v) {
            if (strcasecmp((string)$k, 'X-Hub-Secret') === 0) {
                $provided = is_array($v) ? (string)reset($v) : (string)$v;
                break;
            }
        }

        return $provided !== '' && hash_equals($secret, $provided);
    }
}
