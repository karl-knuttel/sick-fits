const bcrypt                        = require('bcryptjs');
const jwt                           = require('jsonwebtoken');
const { randomBytes }               = require('crypto');
const { promisify }                 = require('util');
const { transport, makeANiceEmail } = require('../mail');
const { hasPermission }             = require('../utils');
const stripe                        = require('../stripe');

const Mutations = {
    async createItem(parent, args, ctx, info) {
        // Check if logged in
        if(!ctx.request.userId) {
            throw new Error('You must be logged in to do that!');
        }

        const item = await ctx.db.mutation.createItem({
            data: {
                // This is how we create a relationship between item and user
                user: {
                    connect: {
                        id: ctx.request.userId
                    }
                },
                ...args
            }
        }, info);

        console.log(item);

        return item;
    },
    updateItem(parent, args, ctx, info) {
        // take copy of updates
        const updates = {...args};
        // remove the ID from the updates
        delete updates.id;
        // run the update method
        return ctx.db.mutation.updateItem(
            {
                data : updates,
                where: {
                    id: args.id
                }
            }, 
            info
        );
    },
    async deleteItem(parent, args, ctx, info) {
        const where = { id: args.id };
        // Find item
        const item = await ctx.db.query.item({ where }, `{ id title user { id } }`);

        // Check for whether they own the item and/or have permissions
        const ownsItem       = item.user.id === ctx.request.userId;
        const hasPermissions = ctx.request.user.permissions.some(permission => ['ADMIN', 'ITEMDELETE'].includes(permission));
        if(!ownsItem && hasPermissions) {
            throw new Error('You can\'t do that!');
        }

        // Delete it
        return ctx.db.mutation.deleteItem({ where }, info);
    },
    async signup(parent, args, ctx, info) {
        // lowercase their email
        args.email = args.email.toLowerCase();

        // hash their password
        const password = await bcrypt.hash(args.password, 10);

        // create user in DB
        const user = await ctx.db.mutation.createUser(
            {
                data: {
                    ...args,
                    password,
                    permissions: { set: ['USER'] }
                }
            }, info
        );

        // import jwt token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

        // set the jwt as a cookie on the response
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge  : 1000 * 60 * 60 * 24 * 365  // 1 year cookie
        });

        // return user to the browser
        return user;
    },
    async signIn(parent, { email, password }, ctx, info) {
        // Check if there's a user with taht email
        const user = await ctx.db.query.user({ where: { email } });
        if(!user) {
            throw new Error(`No such user found from email ${email}`);
        }

        // Check if PW is correct
        const valid = await bcrypt.compare(password, user.password);
        if(!valid) {
            throw new Error('Invalid Password!');
        }

        // Generate JWT token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

        // Set cookie with token
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge  : 1000 * 60 * 60 * 24 * 365  // 1 year cookie
        });

        // Return the user
        return user;
    },
    signout(parent, args, ctx, info) {
        ctx.response.clearCookie('token');
        return { message: 'Goodbye!'};
    },
    async requestReset(parent, args, ctx, info) {
        // Check if user is real
        const user = await ctx.db.query.user({ where:  { email: args.email } });
        if(!user) {
            throw new Error(`No such user found for email ${args.email}`);
        }
        // Set reset token and expiry
        const resetToken       = (await promisify(randomBytes)(20)).toString('hex');
        const resetTokenExpiry = Date.now() + 3600000;
        const res              = await ctx.db.mutation.updateUser({
            where: {  email: args.email },
            data : { resetToken, resetTokenExpiry }
        });
        // Email them the reset token
        const mailRes = await transport.sendMail({
            from   : 'pinksoir@gmail.com',
            to     : user.email,
            subject: 'Your Password Reset Token',
            html   : makeANiceEmail(`Your password reset token is here! 
                    \n\n 
                    <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click here to reset</a>`)
        });
        // return message
        return { message: 'Thanks' };
    },
    async resetPassword(parent, args, ctx, info) {
        // Check if passwords match
        if(args.newPassword !== args.confirmPassword) {
            throw new Error('Passwords don\'t match!');
        }
        // Check if the token is correct/legit        
        // Check if it's expired
        const [user] = await ctx.db.query.users({
            where: {
                resetToken          : args.resetToken,
                resetTokenExpiry_gte: Date.now() - 3600000
            }
        });
        if(!user) {
            throw new Error('The token has either expired or is invalid');
        }
        // Hash new password
        const password = await bcrypt.hash(args.newPassword, 10);
        // Save new password to user and remove old resetToken fields
        const updatedUser = await ctx.db.mutation.updateUser({
            where: { email: user.email },
            data : {
                password,
                resetToken      : null,
                resetTokenExpiry: null
            }
        })
        // generate JWT
        const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
        // Set JWT cookie
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge  : 1000 * 60 * 60 * 24 * 365  // 1 year cookie
        });
        // Return new user
        return updatedUser;
    },
    async updatePermissions(parent, args, ctx, info) {
        // check if they're logged in
        if(!ctx.request.userId) {
            throw new Error('You must be logged in!');
        }

        // query the current user
        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info);

        // check if they have permissions to do this
        hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);

        // update the permissions
        return ctx.db.mutation.updateUser({
            data: {
                permissions: {
                    set: args.permissions
                }
            },
            where: {
                id: args.userId
            }
        }, info);
    },
    async addToCart(parent, args, ctx, info) {
        // Check if they're signed in
        const { userId } = ctx.request;
        if(!userId) {
            throw new Error('You must be signed in to do that!')
        }

        // Query the user's current cart
        const [existingCartItem] = await ctx.db.query.cartItems({
            where: {
                user: { id: userId },
                item: {id: args.id }
            }
        });

        // Check if item is already in the cart and increment by 1 if it is
        if(existingCartItem) {
            console.log('Item is already in tehir cart!')
            return ctx.db.mutation.updateCartItem({
                where: { id: existingCartItem.id },
                data : { quantity: existingCartItem.quantity + 1 }
            }, info);
        }

        // If not create a fresh cart item
        return ctx.db.mutation.createCartItem({
            data: {
                user: {
                    connect: { id: userId }
                },
                item: {
                    connect: { id: args.id }
                }
            }
        }, info)
    },
    async removeFromCart(parent, args, ctx, info) {
        // Find cart item
        const cartItem = await ctx.db.query.cartItem({
            where: {
                id: args.id
            }
        }, `{ id, user { id } }`);

        // make sure we found an item
        if(!cartItem) {
            throw new Error('No cart item found!');
        }

        // Make sure they own the cart item
        if(cartItem.user.id !== ctx.request.userId) {
            throw new Error('Yowch! That ain\'t right');
        }

        // Delete that cart item
        return ctx.db.mutation.deleteCartItem({
            where: {
                id: args.id
            }
        }, info);
    },
    async createOrder(parent, args, ctx, info) {
        // Query the current user and make sure they're signed in
        const { userId } = ctx.request;
        if(!userId) throw new Error('YOu must be signed in to do this!')
        const user = await ctx.db.query.user(
            { where: { id: userId } }, 
                `{
                    id 
                    name 
                    email 
                    cart { 
                        id 
                        quantity 
                        item { 
                            title 
                            price 
                            id 
                            description 
                            image 
                            largeImage
                        } 
                    }
                }`
            )

        // Recalculate the total for the price
        const amount = user.cart.reduce(
            (total, cartItem) => total + cartItem.item.price * cartItem.quantity, 0
        );
        console.log(`Charging a total of ${amount}`);

        // Create the Stripe charge
        const charge = await stripe.charges.create({
            amount,
            currency: 'EUR',
            source  : args.token
        });

        // Convert the cart items to order items
        const orderItems = user.cart.map(cartItem => {
            const orderItem = {
                ...cartItem.item,
                quantity: cartItem.quantity,
                user    : { connect: { id: userId } },
            }
            delete orderItem.id;
            return orderItem;
        })

        // Create the order
        const order = await ctx.db.mutation.createOrder({
            data: {
                total : charge.amount,
                charge: charge.id,
                items : { create: orderItems },
                user  : { connect: { id: userId } }
            }
        });

        // Clear the user's cart and delete cart items
        const cartItemIds = user.cart.map(cartItem => cartItem.id);
        await ctx.db.mutation.deleteManyCartItems({ 
            where: {
                id_in: cartItemIds
            }
        });

        // Return order to the client
        return order;
    }
};

module.exports = Mutations;
