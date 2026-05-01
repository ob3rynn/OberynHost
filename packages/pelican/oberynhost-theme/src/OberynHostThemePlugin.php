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
                fn (): string => view('oberynhosttheme::hooks.auth-brand', $this->brandAssets())->render(),
            )
            ->renderHook(
                PanelsRenderHook::AUTH_PASSWORD_RESET_REQUEST_FORM_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.auth-brand', $this->brandAssets())->render(),
            )
            ->renderHook(
                PanelsRenderHook::AUTH_PASSWORD_RESET_RESET_FORM_BEFORE,
                fn (): string => view('oberynhosttheme::hooks.auth-brand', $this->brandAssets())->render(),
            )
            ->renderHook(
                PanelsRenderHook::TOPBAR_LOGO_AFTER,
                fn (): string => view('oberynhosttheme::hooks.logo-mark', $this->brandAssets())->render(),
            )
            ->renderHook(
                PanelsRenderHook::SIDEBAR_LOGO_AFTER,
                fn (): string => view('oberynhosttheme::hooks.logo-mark', $this->brandAssets())->render(),
            );
    }

    public function boot(Panel $panel): void
    {
        //
    }

    private function brandAssets(): array
    {
        return [
            'oberynIconDataUri' => $this->brandAssetDataUri('oberynhost_icon_web.png'),
        ];
    }

    private function brandAssetDataUri(string $filename): string
    {
        $path = dirname(__DIR__) . '/resources/assets/brand/' . $filename;

        if (! is_file($path)) {
            return '';
        }

        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = $extension === 'jpg' ? 'jpeg' : $extension;
        $contents = file_get_contents($path);

        if ($contents === false) {
            return '';
        }

        return 'data:image/' . $mime . ';base64,' . base64_encode($contents);
    }
}
