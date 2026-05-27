import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ESIM } from '@prisma/client'

interface ESIMCardProps {
  esim: ESIM & {
    purchase: {
      package: {
        name: string
        dataGB: number
      }
    }
  }
}

export function ESIMCard({ esim }: ESIMCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="text-lg">{esim.purchase.package.name}</CardTitle>
            <CardDescription>ICCID: {esim.iccid}</CardDescription>
          </div>
          <Badge variant={
            esim.status === 'ACTIVE' ? 'default' :
            esim.status === 'EXPIRED' ? 'destructive' :
            esim.status === 'SUSPENDED' ? 'destructive' :
            'secondary'
          }>
            {esim.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Data:</span>
            <span>{esim.purchase.package.dataGB}GB</span>
          </div>
          {esim.expiresAt && (
            <div className="flex justify-between">
              <span className="text-gray-500">Expires:</span>
              <span>{esim.expiresAt.toLocaleDateString()}</span>
            </div>
          )}
          {esim.qrCodeUrl && (
            <Button variant="link" size="sm" className="p-0" asChild>
              <a href={esim.qrCodeUrl} target="_blank" rel="noopener noreferrer">
                View QR Code
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
