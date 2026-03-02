package services

import "packages/payments/go-payment-gateway.go"

func SyncGoPendingPayments() bool {
	return ChargeGoInvoice()
}
