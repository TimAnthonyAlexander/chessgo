<?php

namespace App\Providers;

use Override;
use BaseApi\App;
use BaseApi\Container\ServiceProvider;
use BaseApi\Container\ContainerInterface;
use App\Auth\SimpleUserProvider;
use App\Services\EmailService;
use App\Services\GomachineClient;
use App\Services\BotGameService;
use App\Services\WsTicketService;
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

        // gomachine engine client + bot game logic (SPEC §6, §7)
        $container->singleton(GomachineClient::class);
        $container->singleton(BotGameService::class);
        $container->singleton(WsTicketService::class);

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
