import { createStub } from './_stub.js';
export default createStub({
    id: 'create-dexhero', title: 'Loadout', breadcrumb: ['CREATE', 'DEXHERO'],
    variant: 'full', stageMode: 'dim',
    // Forward the route's standard query params into the iframe URL so the
    // legacy page exposes the right UI: ?launchType=existing reveals the
    // contract scanner + dynamic-fee preview (#existing-token-group), and
    // ?address=…&launchType=existing auto-scans on mount. Without this the
    // iframe was always loading ?launchType=new and the scanner stayed hidden.
    legacyHref: (p) => {
        const launchType = p.launchType === 'existing' ? 'existing' : 'new';
        const qs = new URLSearchParams({ launchType });
        if (p.address) qs.set('address', p.address);
        if (p.id) qs.set('id', p.id);
        // modelUrl is the handoff key for resuming a generated DexHero from
        // the profile drafts list — without forwarding it, the iframe loads
        // empty and the user sees a blank model viewer.
        if (p.modelUrl) qs.set('modelUrl', p.modelUrl);
        // imageUrl is the front-view static image used as Tripo input.
        // Showing it on the create page gives the user the visual continuity
        // between the original 4-view flow and the final character.
        if (p.imageUrl) qs.set('imageUrl', p.imageUrl);
        return `/pages/create-dexhero.html?${qs.toString()}`;
    },
    autoEmbed: true,
    parentHash: '#/create/type?method=upload',
    clearOnClose: [
        'dexhero_generated_model',
        'dexhero_launch_type',
    ],
});
