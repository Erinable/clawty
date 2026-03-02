package jobs

import "src/services/go-payment-sync.go"

func RunGoPaymentSyncJob() bool {
	return SyncGoPendingPayments()
}
