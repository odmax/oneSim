import type { Decimal } from '@prisma/client/runtime/library'

export interface PaymentRequest {
  businessId: string
  amount: Decimal | number
  description: string
  purchaseId?: string
}

export interface PaymentResponse {
  success: boolean
  transactionId?: string
  error?: string
}

export interface WalletTopUpRequest {
  businessId: string
  amount: Decimal | number
  paymentMethod: string
}

// Mock process payment - Replace with real payment gateway later
export async function processPayment(
  request: PaymentRequest
): Promise<PaymentResponse> {
  // TODO: Replace with actual payment gateway integration
  // Example: Stripe, Paystack, Flutterwave, etc.
  
  console.log('MOCK: Processing payment', request)
  
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1500))
  
  // Mock successful payment
  const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  return {
    success: true,
    transactionId,
  }
}

// Mock wallet top-up - Replace with real payment gateway later
export async function topUpWallet(
  request: WalletTopUpRequest
): Promise<PaymentResponse> {
  // TODO: Replace with actual payment gateway integration
  
  console.log('MOCK: Topping up wallet', request)
  
  await new Promise(resolve => setTimeout(resolve, 1500))
  
  const transactionId = `WLT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  return {
    success: true,
    transactionId,
  }
}

// Mock get payment methods - Replace with real payment gateway later
export async function getPaymentMethods() {
  // TODO: Replace with actual payment gateway integration
  
  return [
    { id: 'card', name: 'Credit/Debit Card' },
    { id: 'bank_transfer', name: 'Bank Transfer' },
    { id: 'mobile_money', name: 'Mobile Money' },
  ]
}
