import { createStub } from './_stub.js';
export default createStub({
    id: 'generate-model', title: 'Generate Model', breadcrumb: ['MODELS', 'GENERATE'],
    variant: 'right', width: 480, stageMode: 'keep',
    legacyHref: '/pages/generate-model.html',
    autoEmbed: true,
    parentHash: '#/create/type?method=generate',
    // Clear any generated-model draft when panel closes so the create-dexhero
    // panel won't auto-restore a previous generation on its next open.
    clearOnClose: [
        'dexhero_generated_model',
        'dexhero_launch_type',
    ],
});
