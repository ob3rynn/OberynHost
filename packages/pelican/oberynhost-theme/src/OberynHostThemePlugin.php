<?php

namespace OberynHostTheme;

use Filament\Contracts\Plugin;
use Filament\Panel;
use Filament\View\PanelsRenderHook;

class OberynHostThemePlugin implements Plugin
{
    public function getId(): string
    {
        return 'oberynhosttheme';
    }

    public function register(Panel $panel): void
    {
        $panel
            ->brandName('OberynHost')
            ->renderHook(
                PanelsRenderHook::STYLES_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.styles')->render(),
            )
            ->renderHook(
                PanelsRenderHook::AUTH_LOGIN_FORM_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.auth-brand')->render(),
            )
            ->renderHook(
                PanelsRenderHook::AUTH_PASSWORD_RESET_REQUEST_FORM_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.auth-brand')->render(),
            )
            ->renderHook(
                PanelsRenderHook::AUTH_PASSWORD_RESET_RESET_FORM_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.auth-brand')->render(),
            )
            ->renderHook(
                PanelsRenderHook::TOPBAR_LOGO_AFTER,
                fn (): string => view('oberynhosttheme::hooks.logo-mark')->render(),
            )
            ->renderHook(
                PanelsRenderHook::SIDEBAR_LOGO_AFTER,
                fn (): string => view('oberynhosttheme::hooks.logo-mark')->render(),
            );
    }

    public function boot(Panel $panel): void
    {
        //
    }
}
