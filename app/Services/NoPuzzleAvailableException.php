<?php

namespace App\Services;

/**
 * The Premove Trainer's puzzle pool is exhausted for every theme (contract
 * §3.2 — the last resort after the drawn theme AND every fallback theme come
 * up empty through all four rating windows). PremoveGameController answers
 * 503 `{"error":"no puzzle available"}` (contract §8).
 */
class NoPuzzleAvailableException extends \RuntimeException
{
}
