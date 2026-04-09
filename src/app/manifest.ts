import { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PolicyLens',
    short_name: 'PolicyLens',
    description: 'Corporate multi-tenant expense compliance application.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#000000',
    icons: [
      {
        src: '/globe.svg', // Fallback, would ideally build actual PWA icons.
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  }
}
