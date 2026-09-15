# ---------------------------------------------------------------------------
# Application Load Balancer (internet-facing; HTTPS listener deferred).
# No DNS mutation in this task.
# ---------------------------------------------------------------------------

resource "aws_lb" "staging" {
  name               = "onesim-staging-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = false # staging

  tags = merge(local.common_tags, { Name = "onesim-staging-alb" })
}

resource "aws_lb_target_group" "staging" {
  name        = "onesim-staging-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.staging.id
  target_type = "ip"

  deregistration_delay = 60

  health_check {
    path                = var.alb_healthcheck_path
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = merge(local.common_tags, { Name = "onesim-staging-tg" })
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.staging.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.staging.arn
  }

  # HTTPS listener intentionally omitted: no ACM certificate exists in this
  # account/region. Adding it is a REQUIRED later gate after certificate + DNS
  # integration (staging.onetelecom.cloud). No fake certificate is fabricated.
}