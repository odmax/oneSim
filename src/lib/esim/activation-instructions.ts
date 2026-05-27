export const ACTIVATION_INSTRUCTIONS: Record<string, string[]> = {
  iOS: [
    'Go to Settings → Cellular → Add eSIM',
    'Scan the QR code provided in your order details',
    'Alternatively, enter the activation code manually',
    'Follow the on-screen instructions to complete activation',
  ],
  Android: [
    'Go to Settings → Network & Internet → Mobile Network → Add Carrier',
    'Select "Scan QR code" or "Enter activation code" if prompted',
    'Scan the QR code provided in your order details',
    'Follow the on-screen instructions to complete activation',
  ],
  qrCode: [
    'Open your device settings and navigate to the cellular/mobile network section',
    'Select "Add eSIM" or "Download eSIM"',
    'When prompted to scan a QR code, scan the QR code from your order',
    'The eSIM profile will download and activate automatically',
  ],
  manualCode: [
    'If you cannot scan the QR code, use the activation code provided',
    'In your device settings, choose "Enter activation code manually"',
    'Enter the SM-DP+ address and activation code from your order',
    'Complete the activation following on-screen instructions',
  ],
}

export function getActivationInstructions(hasQrCode: boolean): {
  platform: string
  steps: string[]
}[] {
  const instructions: { platform: string; steps: string[] }[] = [
    { platform: 'iPhone / iOS', steps: ACTIVATION_INSTRUCTIONS.iOS },
    { platform: 'Android', steps: ACTIVATION_INSTRUCTIONS.Android },
  ]
  if (hasQrCode) {
    instructions.push({ platform: 'QR Code Install', steps: ACTIVATION_INSTRUCTIONS.qrCode })
  }
  instructions.push({ platform: 'Manual Activation', steps: ACTIVATION_INSTRUCTIONS.manualCode })
  return instructions
}
