export const dynamic = 'force-dynamic'

export default function ApiReferencePage() {
  return (
    <div className="min-h-screen">
      <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossOrigin="anonymous" />
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
      <div id="swagger-ui" />
      <script dangerouslySetInnerHTML={{
        __html: `
          SwaggerUIBundle({
            url: '/api/openapi.json',
            dom_id: '#swagger-ui',
            deepLinking: true,
            presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
            layout: 'BaseLayout',
            defaultModelsExpandDepth: 1,
            defaultModelExpandDepth: 1,
            tryItOutEnabled: ${process.env.SWAGGER_TRY_IT === 'true' ? 'true' : 'false'},
          })
        `,
      }} />
    </div>
  )
}
