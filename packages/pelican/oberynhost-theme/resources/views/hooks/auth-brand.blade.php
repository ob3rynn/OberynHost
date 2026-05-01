<div class="oberyn-auth-brand">
    @if ($oberynIconDataUri ?? '')
        <img class="oberyn-brand-mark" src="{{ $oberynIconDataUri }}" alt="" aria-hidden="true">
    @else
        <span class="oberyn-brand-mark" aria-hidden="true">OH</span>
    @endif

    <div class="oberyn-auth-brand-copy">
        <strong>OberynHost</strong>
        <span>Remote game server hosting</span>
    </div>
</div>
