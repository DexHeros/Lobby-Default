import { createStub } from './_stub.js';
export default createStub({
    id: 'upload-model', title: 'Upload Model', breadcrumb: ['MODELS', 'UPLOAD'],
    variant: 'right', width: 640, stageMode: 'keep',
    legacyHref: '/pages/upload-model.html',
    autoEmbed: true,
    parentHash: '#/models',
    clearOnClose: [
        'dexhero_generated_model',
        'dexhero_launch_type',
    ],
});
