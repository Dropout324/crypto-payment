import nextConfig from 'eslint-config-next';

const config = [...nextConfig, { ignores: ['.next/**'] }];

export default config;
