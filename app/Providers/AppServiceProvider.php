<?php

namespace App\Providers;

use Override;
use BaseApi\App;
use BaseApi\Container\ServiceProvider;
use BaseApi\Container\ContainerInterface;
use App\Auth\SimpleUserProvider;
use App\Services\EmailService;
use App\Services\GomachineClient;
use App\Services\ZugzwangClient;
use App\Services\EngineSelector;
use App\Services\BotGameService;
use App\Services\GuessGameService;
use App\Services\GameAnalysisService;
use App\Services\WsTicketService;
use App\Services\HubClient;
use App\Services\Glicko2Service;
use App\Services\AnticheatService;
use App\Services\StreakService;
use BaseApi\Auth\UserProvider;

/**
 * Application service provider.
 * 
 * Register application-specific services here.
 */
class AppServiceProvider extends ServiceProvider
{
    #[Override]
    public function register(ContainerInterface $container): void
    {
        // Register the user provider
        $container->singleton(UserProvider::class, SimpleUserProvider::class);

        // Register the email service as singleton
        $container->singleton(EmailService::class);

        // gomachine + zugzwang engine clients (SPEC §6, §7; WIRING_RECON.md §B).
        // GomachineClient/ZugzwangClient are each bound to one URL — the two
        // chokepoints. EngineSelector composes both (zugzwang-primary,
        // gomachine-fallback by default, App::config('engine.primary')) and is
        // what most consumers get instead of a raw client, so the whole site
        // is reversible to gomachine-only via ENGINE_PRIMARY with zero code
        // change. EngineMatchController (admin engine-vs-engine) keeps direct
        // access to both concrete clients for explicit per-side selection.
        $container->singleton(GomachineClient::class);
        $container->singleton(ZugzwangClient::class);
        $container->singleton(EngineSelector::class);
        $container->singleton(BotGameService::class);
        $container->singleton(GuessGameService::class);
        $container->singleton(GameAnalysisService::class);
        $container->singleton(WsTicketService::class);

        // Realtime hub stats client (homepage lobby counts + anti-cheat probe)
        $container->singleton(HubClient::class);

        // Anti-cheat harness: raises advisory flags (never auto-bans) — SPEC §Anti-cheat
        $container->singleton(AnticheatService::class);

        // Glicko-2 ratings (category mapping + rating math)
        $container->singleton(Glicko2Service::class);

        // "The Flame" daily-activity streak roll logic (single source of truth)
        $container->singleton(StreakService::class);

        // Example: Register a custom service with manual configuration
        // $container->singleton(SomeService::class, function (ContainerInterface $c) {
        //     return new SomeService($c->make(SomeDependency::class));
        // });
    }

    #[Override]
    public function boot(ContainerInterface $container): void
    {
        // Boot services after registration
        // Example: Configure services that depend on other services
        
        // Set the user provider in the App
        App::setUserProvider($container->make(UserProvider::class));
    }
}
